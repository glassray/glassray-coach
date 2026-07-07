# The support-bot demo: find the failures your dashboards can't see

A complete, runnable walkthrough of the Coach loop — **discover → codify as evals →
fix → prove no regression** — built around a simulated customer-support agent for a
fictional store. Everything the agent "says" is canned (no API key needed,
deterministic), but the instrumentation is the real
[`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js) SDK — the
`import` in [`support-bot.mjs`](./support-bot.mjs) is exactly what a production
agent ships.

The premise: the agent handles **34 tickets** and the dashboards look great —
~97% success, normal latency, no alarms. But **11 of those "successful" replies
are wrong**: they violate the agent's own policy in three recurring ways, and none
of them raised an error. That's the class of failure Coach exists for.

| Planted failure mode | What the agent does wrong | How often |
| --- | --- | --- |
| **Ungrounded order status** | Answers "where's my order?" with an *invented* status — no `lookup_order` call | 5 of 8 order tickets |
| **Unauthorized refund** | Issues refunds over the **$100 policy limit** instead of escalating | 3 of 5 large refunds |
| **PII leak** | Echoes the customer's **full card number** back in the reply | 3 of 4 card updates |

The bugs are **intermittent** (some tickets in each category go fine), the way real
agent failures are. The corpus also has ordinary messy traffic: a knowledge-base
timeout the agent recovers from, one hard crash (billing service down), an
18k-token outlier, and two multi-tool waterfalls.

## 0. Start Coach

From a clone of this repo:

```sh
npm install && npm run build:ui
node bin/glassray.mjs          # dashboard + ingest on http://127.0.0.1:5899
```

Leave it running and open <http://127.0.0.1:5899>. Starting from a clean slate
demos best: `node bin/glassray.mjs reset --yes` first if you've sent traces before.

## 1. Send a day of traffic

```sh
node examples/support-bot/support-bot.mjs      # 34 tickets through the buggy agent
```

Open **Overview**: 34 traces, one error (~3%), token and cost rollups — a healthy-looking
service. In **Traces**, click into a waterfall: inputs, outputs, models, and token
counts on every span. Worth showing off:

- Sort by tokens → the **18k-token outlier** (a customer pasted an entire email thread).
- The trace with the red span — `search_kb` timed out and the agent degraded gracefully.
- The one hard failure — `get_invoice` timed out and the whole ticket errored.

Everything else is green. This is the "monitoring says we're fine" starting point.

## 2. Find what's actually broken

**Deviations → Run discovery.** Coach's LLM judge reads the actual conversations and
clusters the recurring ways the agent misbehaves — expect the three planted failure
modes above to surface (it's an LLM pass, so labels and counts can vary slightly).

Click one: a plain-language rule, severity, and the exact traces that match. None of
these threw an error — they're *semantic* failures, invisible to error-rate dashboards.

> Discovery needs a model, and its speed depends on the provider. On the
> zero-config `~/.claude` subscription path a run over this corpus takes several
> minutes (each judge call is a full Agent SDK turn) — kick it off, then tour the
> traces while it works; the run card shows live "scanned N/M" progress. With a
> metered key (`GLASSRAY_LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`) it's
> roughly a minute. On the deterministic `mock` provider it returns a single
> placeholder deviation (mechanics only, no real analysis).

## 3. Freeze each deviation into an eval

On each deviation, click **Save as eval**. That turns its rule into a repeatable
pass/fail check. Run one now to get a baseline — an eval run scores the newest
traces (20 by default), so you'll see it fail on the buggy corpus. You can also
hand-write an eval under **Evals** (e.g. "The reply must never contain a full card
number.").

## 4. Ship the fix, prove it

```sh
node examples/support-bot/support-bot.mjs --fixed    # same 34 tickets, bugs corrected
```

The fixed agent grounds every order answer in `lookup_order`, escalates over-limit
refunds to a human, and refers to cards by their last 4 digits. Now **Evals → each →
Re-run eval**: the pass rate climbs, and the run history shows the trend. If a later
change *reintroduced* a failure that used to pass, the eval would flag it as a
**regression**. That ratchet is the whole loop: discover → codify → prevent.

## 5. Debug a single call (optional)

Open any trace, select an LLM span, and hit **Replay** — edit the model / system /
prompt and re-issue it through your local LLM, with the fresh output beside the
original. The viewer becomes a debugger.

## 6. Drive it from your coding agent (optional)

With Coach running, register it as an MCP server:

```sh
claude mcp add glassray -- npx @glassray/coach mcp
```

Then ask Claude Code things like *"which support-bot traces echoed a full card
number back to the customer?"* or *"run discovery and summarize what it found"* —
the same traces, deviations, and evals, from your editor.

---

## The 5-minute demo script

Timing note: on the zero-config subscription provider, discovery takes several
minutes — so the script starts it early and tours the dashboard while it runs. On
a metered key it's ~a minute and the order barely matters. For a rehearsal-free
option, run discovery *before* the audience arrives and demo the finished results.

1. **Before the demo:** `reset --yes`, start Coach, run the buggy corpus. Keep the
   terminal visible — its closing summary sets up the story.
2. **Deviations → Run discovery** — kick it off first thing: "while we look around,
   Coach is reading the actual conversations and clustering recurring misbehavior —
   no rules written in advance."
3. **Overview** — "34 conversations today, 97% success. Ship it?"
4. **Traces** — open one clean waterfall (inputs/outputs/tokens on every span), then
   sort by tokens and show the 18k outlier. "Full visibility — but everything's green."
5. **Back to Deviations** — open each one: the rule, the evidence, the offending
   traces. "Eleven wrong answers. Zero errors. Your error rate never saw them."
6. **Save as eval** on each, run one for a baseline. "The finding is now a test."
7. Run `--fixed`, re-run the evals — pass rates climb. "Discovery finds it, evals
   lock it in. That's the loop."

## Files

| File | Role |
| --- | --- |
| [`support-bot.mjs`](./support-bot.mjs) | The simulated agent (instrumented with `@glassray/tracing`), the 34-ticket corpus, and the runner — `--fixed` turns the bugs off. |

## Reset between runs

`node bin/glassray.mjs reset --yes` wipes the local data dir for a clean slate.
