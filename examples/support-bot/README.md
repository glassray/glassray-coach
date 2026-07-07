# Sample flow: debugging & hardening a support agent

A complete, runnable walkthrough of how you'd actually use Coach while building an
AI agent — from "traces are landing" to "regressions are locked out." It ships a
small **simulated** support agent whose LLM/tool calls are canned (so it runs with
no API key and is deterministic), instrumented exactly the way you'd instrument a
real one.

The agent has three **recurring, silent** bugs — wrong answers that are *not*
errors, so ordinary monitoring shows everything green. That's the point: Coach
finds them.

> Instrumentation uses `./trace-lite.mjs`, a ~120-line stand-in for the
> [`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js) SDK with the
> same `trace / llm / tool` shape. `@glassray/tracing` is on npm — a real agent
> imports it directly instead of the shim.

## 0. Start Coach

```sh
cd coach
npm install && npm run build:ui
node bin/glassray.mjs         # dashboard + ingest on http://127.0.0.1:5899
```

Leave it running and open <http://127.0.0.1:5899>.

## 1. Generate a corpus

```sh
node examples/support-bot/support-bot.mjs      # 26 tickets through the "buggy" agent
```

Open **Overview**. You'll see **26 traces, 0.0% errors** — every run "succeeded."
The **Traces** list shows the agent → llm → tool waterfalls; click any one to see
inputs, outputs, and span attributes.

## 2. Find what's actually broken

Go to **Deviations → Run discovery**. Coach's LLM judge reads the traces and
clusters the recurring ways the agent misbehaves. Within a run it surfaces three
deviation types:

| Deviation | What the agent did wrong | Examples |
| --- | --- | --- |
| **Ungrounded order status** | Answered "where's my order" with an invented status and **no `lookup_order` call** | 7 |
| **Unauthorized refund** | Issued refunds over the **$100 policy limit** instead of escalating | 4 |
| **PII leak** | Echoed the customer's **full card number** back in the reply | 3 |

None of these threw an error — they're *semantic* deviations. Click one to read its
plain-language rule and the exact traces that match it.

> Discovery needs a model. Locally it uses your `~/.claude` subscription
> (zero-config) — see the root README's "LLM provider" table. On the deterministic
> `mock` provider it returns a single placeholder deviation (mechanics only, no real
> analysis).

## 3. Turn a deviation into a repeatable check

On a deviation you care about, click **Save as eval**. That freezes its rule into a
pass/fail check you can re-run against any traces. Do it for all three. (You can
also hand-write an eval under **Evals** — e.g. "The reply must never contain a full
card number.")

## 4. Fix the agent, prove it

```sh
node examples/support-bot/support-bot.mjs --fixed    # same 26 tickets, bugs corrected
```

Now the fixed agent grounds order status in a `lookup_order` call, escalates large
refunds, and redacts card numbers. Go to **Evals → (each) → Re-run eval**. The pass
rate climbs — and if a change had *reintroduced* a previously-passing failure, the
eval would flag it as a **regression**. That ratchet is the whole loop: discover →
codify → prevent.

## 5. Debug a single call (optional)

Open any trace, select an LLM span, and hit **Replay** — edit the model / system /
prompt and re-issue it through your local LLM, with the fresh output beside the
original. The viewer becomes a debugger.

## From your coding agent (optional)

With Coach running, register it as an MCP server so Claude Code / Cursor can query
these real traces and run discovery/evals for you:

```sh
claude mcp add glassray -- node <path-to>/coach/bin/glassray.mjs mcp
```

---

### Files

| File | Role |
| --- | --- |
| `trace-lite.mjs` | Dependency-free tracing shim (SDK-shaped); emits OTLP to Coach. |
| `support-bot.mjs` | The simulated agent + a 26-ticket corpus + the runner (`--fixed` toggles the bugs off). |

### Reset between runs

`node bin/glassray.mjs reset --yes` wipes the local data dir for a clean slate.
