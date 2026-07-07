import { useMemo, useState } from "react";
import { CopyBlock } from "./TraceList";

/** One instrumentation recipe: a tab label + a snippet built from the live endpoint/key. */
interface Recipe {
  key: string;
  label: string;
  snippet: (endpoint: string, apiKey: string) => string;
}

/** Base URL (no path) of the local ingest endpoint — what OTel exporters want. */
const baseOf = (endpoint: string): string => endpoint.replace(/\/v1\/traces$/, "");

/*
 * The instrumentation on-ramp. Coach ingests OTLP/JSON, so every recipe either
 * uses the @glassray/tracing SDK (which speaks it natively) or points a standard
 * OTel exporter at the endpoint with `http/json`. Ordered easiest-first.
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

/** Tabbed copy-paste instrumentation recipes for the empty state. */
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
