#!/usr/bin/env node
/*
 * send-otlp.mjs — a zero-dependency demo that sends one realistic multi-span
 * trace to a running Glassray Coach, exactly the way an instrumented agent
 * would (OTLP/JSON, gzip-compressed, bearer-authed). Doubles as a "give me some
 * sample data" tool.
 *
 *   node bin/glassray.mjs start   # start Coach in another terminal
 *   node examples/send-otlp.mjs   # then run this — it auto-discovers the local key
 *
 * Config (all optional — it discovers the rest from the local server):
 *   GLASSRAY_ENDPOINT   base URL of your Coach (default http://127.0.0.1:5899)
 *   GLASSRAY_API_KEY    ingest key (default: read from GET /api/info on loopback)
 */

import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Base URL of the local Coach (no path). */
const base = (process.env.GLASSRAY_ENDPOINT ?? 'http://127.0.0.1:5899').replace(/\/v1\/traces$|\/+$/g, '');

/** Discover the ingest key from the loopback /api/info when not provided. */
const resolveKey = async () => {
  if (process.env.GLASSRAY_API_KEY) return process.env.GLASSRAY_API_KEY;
  const res = await fetch(`${base}/api/info`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`Coach not reachable at ${base} — start it with \`node bin/glassray.mjs start\` (or set GLASSRAY_ENDPOINT).`);
  }
  return (await res.json()).apiKey;
};

/** Random lowercase hex id of `bytes` bytes (32-hex trace ids, 16-hex span ids). */
const id = (bytes) => randomBytes(bytes).toString('hex');

/** Build one OTLP `{ key, value }` attribute, typing strings vs ints. */
const attr = (key, value) =>
  typeof value === 'number'
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: String(value) } };

/** Nanosecond epoch string `ms` milliseconds from `t0`. */
const ns = (t0, ms) => String((t0 + ms) * 1_000_000);

const main = async () => {
  const apiKey = await resolveKey();
  const traceId = id(16);
  const t0 = Date.now() - 4_000; // the trace "started" ~4s ago
  const rootSpan = id(8);
  const llmSpan = id(8);
  const toolSpan = id(8);

  // A three-span trace: an agent that makes one LLM call and one tool call.
  const spans = [
    {
      traceId, spanId: rootSpan, name: 'handle-support-ticket', kind: 1,
      startTimeUnixNano: ns(t0, 0), endTimeUnixNano: ns(t0, 3600), status: {},
      attributes: [
        attr('gen_ai.operation.name', 'invoke_agent'),
        attr('glassray.agent', 'support-agent'),
        attr('glassray.environment', 'local'),
        attr('input.value', 'My order #4821 never arrived — what happened?'),
        attr('output.value', 'Your order shipped Tuesday and is out for delivery today.'),
      ],
    },
    {
      traceId, spanId: llmSpan, parentSpanId: rootSpan, name: 'chat claude-opus-4-8', kind: 1,
      startTimeUnixNano: ns(t0, 200), endTimeUnixNano: ns(t0, 2100), status: {},
      attributes: [
        attr('gen_ai.operation.name', 'chat'),
        attr('gen_ai.request.model', 'claude-opus-4-8'),
        attr('gen_ai.provider.name', 'anthropic'),
        attr('gen_ai.usage.input_tokens', 1240),
        attr('gen_ai.usage.output_tokens', 320),
        attr('input.value', JSON.stringify({ messages: [
          { role: 'system', content: 'You are a helpful support agent. Ground every claim in the tools.' },
          { role: 'user', content: 'My order #4821 never arrived — what happened?' },
        ] })),
        attr('output.value', 'Let me look up order #4821 for you.'),
      ],
    },
    {
      traceId, spanId: toolSpan, parentSpanId: rootSpan, name: 'lookup-order', kind: 1,
      startTimeUnixNano: ns(t0, 2200), endTimeUnixNano: ns(t0, 2600), status: {},
      attributes: [
        attr('gen_ai.operation.name', 'execute_tool'),
        attr('gen_ai.tool.name', 'lookup-order'),
        attr('input.value', JSON.stringify({ orderId: '4821' })),
        attr('output.value', JSON.stringify({ status: 'out_for_delivery', shippedAt: '2026-07-01' })),
      ],
    },
  ];

  const envelope = {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', 'support-agent')] },
        scopeSpans: [{ scope: { name: 'examples/send-otlp' }, spans }],
      },
    ],
  };

  // Send it the way the SDK does: OTLP/JSON, gzipped, bearer-authed.
  const body = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
  const res = await fetch(`${base}/v1/traces`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      authorization: `Bearer ${apiKey}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`ingest failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => '')}`);
  }
  console.log('✓ sent 1 trace to', `${base}/v1/traces`, `(${body.length} gzipped bytes)`);
  console.log('  view it at', `${base}/#/trace/${traceId}`);
};

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
