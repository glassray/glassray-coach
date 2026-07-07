# Coach examples

Two ways to get a trace into a locally-running Coach. Start Coach first:

```sh
cd coach
npm install && npm run build:ui
node bin/glassray.mjs       # serves the dashboard + ingest on http://127.0.0.1:5899
```

## 1. `send-otlp.mjs` — zero dependencies, works today

Sends one realistic **AGENT → LLM → TOOL** trace as raw OTLP/JSON (gzip-compressed,
bearer-authed) — exactly the wire format the SDK produces. It auto-discovers the local
ingest key from `GET /api/info`, so there's nothing to configure:

```sh
node examples/send-otlp.mjs
# ✓ sent 1 trace to http://127.0.0.1:5899/v1/traces (… gzipped bytes)
#   view it at http://127.0.0.1:5899/#/trace/<id>
```

Handy as a "give me some sample data" button while developing Coach.

## 2. `with-glassray-sdk.mjs` — the real SDK

The same trace, produced by the [`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js)
SDK — how you'd actually instrument an agent. The SDK handles OTLP encoding, gzip,
batching, and retries.

```sh
npm install @glassray/tracing
export GLASSRAY_ENDPOINT="http://127.0.0.1:5899"   # else it sends to Glassray Cloud
export GLASSRAY_API_KEY="$(curl -s http://127.0.0.1:5899/api/info | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).apiKey))')"
node examples/with-glassray-sdk.mjs
```

> The SDK's OTLP attribute contract is identical to the one Coach's normalizer reads, so
> traces render the same whether you use the SDK or hand-built OTLP. `@glassray/tracing`
> is [on npm](https://www.npmjs.com/package/@glassray/tracing), and a Coach test drives a
> real round trip through it (`server/sdk-roundtrip.test.ts`) so the wire format can't
> drift.

## 3. `support-bot/` — the full developer walkthrough

A simulated customer-support agent (`examples/support-bot/support-bot.mjs`) instrumented
with a dependency-free, SDK-shaped tracing shim (`trace-lite.mjs`) that emits a corpus of
~26 traces. Three **recurring** failure modes are planted in the corpus — answering
order-status questions with no `lookup_order` call, issuing refunds over the $100 limit,
and echoing full card numbers back to the customer — so **Run discovery** has real signal
to cluster.

```sh
node examples/support-bot/support-bot.mjs           # the buggy corpus
# … save the deviations as evals, then prove the fix:
node examples/support-bot/support-bot.mjs --fixed    # same tickets, bugs corrected
```

The full step-by-step loop — discover → codify as evals → fix → prove no regression —
is in [`examples/support-bot/README.md`](support-bot/README.md).
