# Coach examples

Ways to get traces into a locally-running Coach. The example scripts run from a
clone of this repo; Coach itself needs no clone — start it first:

```sh
npx @glassray/coach start   # serves the dashboard + ingest on http://127.0.0.1:5899
```

## 1. `send-otlp.mjs` — one sample trace, zero dependencies

Sends one realistic **AGENT → LLM → TOOL** trace as raw OTLP/JSON (gzip-compressed,
bearer-authed) — exactly the wire format the SDK produces. It auto-discovers the local
ingest key from `GET /api/info`, so there's nothing to configure:

```sh
node examples/send-otlp.mjs
# ✓ sent 1 trace to http://127.0.0.1:5899/v1/traces (… gzipped bytes)
#   view it at http://127.0.0.1:5899/#/trace/<id>
```

Handy as a "give me some sample data" button while developing Coach, and as a
reference for the raw wire format if you're integrating from a language without an
SDK.

## 2. `support-bot/` — the demo, and the full developer walkthrough

A simulated customer-support agent instrumented with the real
[`@glassray/tracing`](https://www.npmjs.com/package/@glassray/tracing) SDK (a
devDependency of this repo, so it works right after `npm install`). It sends **34
tickets** of realistic traffic — including a tool timeout, one hard failure, and an
18k-token outlier — with three **recurring, intermittent** failure modes planted:
ungrounded order-status answers, refunds over the $100 limit, and full card numbers
echoed back to customers. None of them error, so the dashboards stay green — until
**Run discovery** clusters them.

```sh
node examples/support-bot/support-bot.mjs            # the buggy corpus
# … scope the behaviours as flows, save the deviations as flow-scoped evals, then:
node examples/support-bot/support-bot.mjs --fixed    # same tickets, bugs corrected —
#     the traffic classifies into your flows and the evals rerun on their own
```

The step-by-step loop — discover → scope as durable flows → codify as flow-scoped
evals → fix → watch the autorun reruns prove it — plus a 5-minute demo script is in
[`examples/support-bot/README.md`](support-bot/README.md). Since it uses the real
SDK, `support-bot.mjs` doubles as the reference for instrumenting your own agent
(`glassray.trace` / `t.llm` / `t.tool`); a Coach test drives a real round trip
through the published package (`server/sdk-roundtrip.test.ts`) so the wire format
can't drift.
