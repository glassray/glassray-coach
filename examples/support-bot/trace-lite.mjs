/*
 * trace-lite.mjs — a tiny, dependency-free stand-in for the @glassray/tracing
 * SDK, so this example runs with zero install. It mirrors the SDK's ergonomics
 * (`new Glassray().trace(...)` with `t.llm` / `t.tool`) and emits the exact same
 * OTLP/JSON attribute contract Coach's normalizer reads — so traces render
 * identically. `@glassray/tracing` is on npm — a real agent swaps one import:
 *
 *   -import { Glassray } from './trace-lite.mjs';
 *   +import { Glassray } from '@glassray/tracing';
 *
 * The real SDK adds batching, retries, and serverless flush helpers; this shim
 * ships each trace inline for clarity.
 */
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Random lowercase hex id of `bytes` bytes (16 for trace ids, 8 for span ids). */
const id = (bytes) => randomBytes(bytes).toString('hex');

/** Build one OTLP `{ key, value }` attribute, typing ints vs strings (objects are JSON-encoded). */
const attr = (key, value) =>
  typeof value === 'number'
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } };

/** Epoch-millisecond `ms` as an OTLP nanosecond string. */
const toNs = (ms) => String(Math.round(ms) * 1_000_000);

/**
 * The per-trace span collector handed to your callback. Call `t.llm(...)` and
 * `t.tool(...)` to record child steps; each returns the wrapped call's result so
 * your agent logic reads naturally.
 */
class Span {
  constructor(traceId, rootId) {
    this.traceId = traceId;
    this.rootId = rootId;
    this.spans = [];
  }

  /** Record an LLM call: `opts` = { model, provider, input? }, `fn` returns { content, usage:{ input_tokens, output_tokens } }. */
  async llm(name, opts, fn) {
    const start = Date.now();
    const res = await fn();
    const end = Date.now();
    this.spans.push({
      spanId: id(8), parentSpanId: this.rootId, name, start, end, error: null,
      attributes: [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.request.model', opts.model),
        attr('gen_ai.provider.name', opts.provider ?? 'unknown'),
        attr('gen_ai.usage.input_tokens', res?.usage?.input_tokens ?? 0),
        attr('gen_ai.usage.output_tokens', res?.usage?.output_tokens ?? 0),
        ...(opts.input !== undefined ? [attr('input.value', opts.input)] : []),
        attr('output.value', res?.content ?? ''),
      ],
    });
    return res;
  }

  /** Record a tool call: `opts` = { input? }, `fn` returns the tool output. A thrown fn marks the span errored and re-throws. */
  async tool(name, opts, fn) {
    const start = Date.now();
    try {
      const out = await fn();
      this.spans.push({
        spanId: id(8), parentSpanId: this.rootId, name, start, end: Date.now(), error: null,
        attributes: [
          attr('gen_ai.operation.name', 'execute_tool'),
          attr('gen_ai.tool.name', name),
          ...(opts.input !== undefined ? [attr('input.value', opts.input)] : []),
          attr('output.value', out),
        ],
      });
      return out;
    } catch (err) {
      this.spans.push({
        spanId: id(8), parentSpanId: this.rootId, name, start, end: Date.now(),
        error: err?.message ?? String(err),
        attributes: [attr('gen_ai.operation.name', 'execute_tool'), attr('gen_ai.tool.name', name)],
      });
      throw err;
    }
  }
}

/** Coach tracer: `new Glassray({ agent })`, then `await g.trace(name, { input }, async (t) => {...})`. */
export class Glassray {
  constructor({ agent = 'agent', environment = 'local', endpoint, apiKey } = {}) {
    this.agent = agent;
    this.environment = environment;
    this.base = (endpoint ?? process.env.GLASSRAY_ENDPOINT ?? 'http://127.0.0.1:5899').replace(
      /\/v1\/traces$|\/+$/g,
      '',
    );
    this.apiKey = apiKey ?? process.env.GLASSRAY_API_KEY ?? null;
    this.sent = 0;
  }

  /** Resolve the ingest key once from the loopback /api/info when not supplied. */
  async #key() {
    if (this.apiKey) return this.apiKey;
    const res = await fetch(`${this.base}/api/info`).catch(() => null);
    if (!res || !res.ok) throw new Error(`Coach not reachable at ${this.base} — start it with \`glassray start\`.`);
    this.apiKey = (await res.json()).apiKey;
    return this.apiKey;
  }

  /**
   * Run one traced agent invocation. `meta.input` becomes the root span's
   * input.value; the callback's return becomes its output.value. A thrown
   * callback marks the root errored (and re-throws). Ships the trace to Coach.
   */
  async trace(name, meta, fn) {
    const rootId = id(8);
    const span = new Span(id(16), rootId);
    const start = Date.now();
    let output;
    let error = null;
    try {
      output = await fn(span);
    } catch (err) {
      error = err?.message ?? String(err);
    }
    const end = Date.now();
    const rootAttrs = [
      attr('gen_ai.operation.name', 'invoke_agent'),
      attr('glassray.agent', this.agent),
      attr('glassray.environment', this.environment),
      ...(meta?.input !== undefined ? [attr('input.value', meta.input)] : []),
      attr('output.value', error ? `Error: ${error}` : output ?? ''),
    ];
    for (const [k, v] of Object.entries(meta ?? {})) {
      if (k !== 'input') rootAttrs.push(attr(`glassray.${k}`, v));
    }
    const spans = [
      { traceId: span.traceId, spanId: rootId, name, start, end, error, attributes: rootAttrs },
      ...span.spans.map((s) => ({ ...s, traceId: span.traceId })),
    ];
    await this.#ship(spans);
    if (error) throw new Error(error);
    return output;
  }

  /** Encode the collected spans as one gzipped OTLP/JSON envelope and POST it to Coach. */
  async #ship(spans) {
    const apiKey = await this.#key();
    const otlpSpans = spans.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
      name: s.name,
      kind: 1,
      startTimeUnixNano: toNs(s.start),
      endTimeUnixNano: toNs(s.end),
      status: s.error ? { code: 2, message: s.error } : {},
      attributes: s.attributes,
    }));
    const envelope = {
      resourceSpans: [
        {
          resource: { attributes: [attr('service.name', this.agent)] },
          scopeSpans: [{ scope: { name: 'examples/support-bot' }, spans: otlpSpans }],
        },
      ],
    };
    const body = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
    const res = await fetch(`${this.base}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`ingest failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => '')}`);
    this.sent += 1;
  }

  /** No-op for API-compatibility with the real SDK (this shim ships inline). */
  async flush() {}

  /** Delivery stats, mirroring the SDK. */
  stats() {
    return { sent: this.sent };
  }
}
