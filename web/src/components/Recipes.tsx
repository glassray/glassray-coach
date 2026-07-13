import { useCallback, useMemo, useState } from "react";
import { CopyBlock, copyText } from "./TraceList";

/** One instrumentation recipe: a tab label + a snippet built from the live endpoint/key. */
interface Recipe {
  key: string;
  label: string;
  snippet: (endpoint: string, apiKey: string) => string;
}

/** Base URL (no path) of the local ingest endpoint — what OTel exporters want. */
const baseOf = (endpoint: string): string => endpoint.replace(/\/v1\/traces$/, "");

/*
 * The manual instrumentation on-ramp (the coding-agent hand-off above is the
 * primary path). Coach ingests OTLP/JSON, so every recipe either uses the
 * @glassray/tracing SDK (which speaks it natively) or points a standard OTel
 * exporter at the endpoint with `http/json`. Ordered easiest-first.
 */
const RECIPES: Recipe[] = [
  {
    key: "sdk",
    label: "@glassray/tracing",
    snippet: (endpoint, apiKey) => `# Glassray's zero-dependency tracing SDK — speaks Coach's OTLP/JSON natively.
pnpm add @glassray/tracing

# The SDK defaults to Glassray Cloud — point it at your local Coach:
export GLASSRAY_ENDPOINT="${endpoint}"
export GLASSRAY_API_KEY="${apiKey}"

import { Glassray } from "@glassray/tracing";
const glassray = new Glassray({ environment: "local" });

// Wrap your agent — t.llm(...) / t.tool(...) capture each step.
await glassray.trace("handle-request", { customer: "acme" }, async (t) => {
  const plan = await t.llm("plan", { model: "claude-opus-4-8", provider: "anthropic" }, () =>
    llm.create(request),
  );
  return t.tool("search-kb", () => searchKb(plan));
});

await glassray.flush(); // serverless: waitUntil(glassray.flush())`,
  },
  {
    key: "vercel",
    label: "Vercel AI SDK",
    snippet: (endpoint, apiKey) => `# Vercel AI SDK emits OTel spans when telemetry is on — export them to Coach.
pnpm add @vercel/otel @opentelemetry/exporter-trace-otlp-http

# instrumentation.ts
import { registerOTel } from "@vercel/otel";
import { OTLPHttpJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
registerOTel({
  serviceName: "my-agent",
  traceExporter: new OTLPHttpJsonTraceExporter({
    url: "${baseOf(endpoint)}/v1/traces",
    headers: { Authorization: "Bearer ${apiKey}" },
  }),
});

// then, per call:
const result = await generateText({
  model, prompt,
  experimental_telemetry: { isEnabled: true },
});`,
  },
  {
    key: "otel-env",
    label: "OpenAI / Anthropic (OTel)",
    snippet: (endpoint, apiKey) => `# Any OpenTelemetry / OpenLLMetry setup — point the exporter at Coach with http/json.
# (e.g. Traceloop's openllmetry auto-instruments the OpenAI / Anthropic SDKs.)
export OTEL_EXPORTER_OTLP_ENDPOINT="${baseOf(endpoint)}"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${apiKey}"
export OTEL_SERVICE_NAME="my-agent"`,
  },
  {
    key: "raw",
    label: "Raw OTLP",
    snippet: (endpoint, apiKey) => `# Send OTLP/JSON directly (application/json — NOT protobuf).
POST ${endpoint}
Authorization: Bearer ${apiKey}
Content-Type: application/json

{ "resourceSpans": [ /* … your spans … */ ] }`,
  },
];

/** 14px stroke copy-glyph for the hand-off CTA. */
const CopyIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

/** Check glyph shown once the prompt is on the clipboard. */
const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/**
 * The primary onboarding path: hand the whole setup to a coding agent. One
 * prominent copy action; the prompt itself is soft-wrapped and scrolls
 * vertically behind a fade so nothing is ever clipped mid-glance.
 */
export const AgentHandoff = ({ prompt }: { prompt: string }) => {
  const [copied, setCopied] = useState(false);

  /** Copy the full prompt and briefly confirm on the button itself. */
  const copy = useCallback(() => {
    void copyText(prompt).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [prompt]);

  return (
    <section className="handoff">
      <div className="handoff-head">
        <div>
          <div className="handoff-kicker">Fastest setup</div>
          <div className="handoff-title">Let your coding agent wire everything</div>
        </div>
        <button
          type="button"
          className={`handoff-copy${copied ? " handoff-copy-done" : ""}`}
          onClick={copy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <ol className="handoff-steps">
        <li>
          <span className="handoff-step-n">1</span>
          <div>
            <b>Copy the prompt</b>
            <small>Everything below, wiring included</small>
          </div>
        </li>
        <li>
          <span className="handoff-step-n">2</span>
          <div>
            <b>Paste into your agent</b>
            <small>Claude Code, Codex, or Copilot — in your agent&rsquo;s repo</small>
          </div>
        </li>
        <li>
          <span className="handoff-step-n">3</span>
          <div>
            <b>Run your agent</b>
            <small>Traces, flows, and rules appear here live</small>
          </div>
        </li>
      </ol>
      <div className="handoff-prewrap">
        <pre className="handoff-pre">{prompt}</pre>
      </div>
    </section>
  );
};

/** Tabbed copy-paste instrumentation recipes for the empty state's manual path. */
export const Recipes = ({ endpoint, apiKey }: { endpoint: string; apiKey: string }) => {
  const [active, setActive] = useState(RECIPES[0]!.key);
  const recipe = useMemo(() => RECIPES.find((r) => r.key === active) ?? RECIPES[0]!, [active]);
  return (
    <div className="recipes">
      <div className="recipe-tabs" role="tablist">
        {RECIPES.map((r) => (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={r.key === active}
            className={`recipe-tab${r.key === active ? " recipe-tab-active" : ""}`}
            onClick={() => setActive(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <CopyBlock snippet={recipe.snippet(endpoint, apiKey)} />
    </div>
  );
};
