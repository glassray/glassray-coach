# The support-bot demo: find the failures your dashboards can't see

A complete, runnable walkthrough of the Coach loop — **discover → scope as flows →
codify as flow-scoped evals → fix → watch the reruns happen on their own** — built
around a simulated customer-support agent for a fictional store, **Nimbus Outfitters**. Everything the agent "says" is canned (no API key needed,
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
node bin/glassray.mjs start    # dashboard + ingest on http://127.0.0.1:5899
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

## 3. Scope each behaviour as a durable flow

Every ticket lands as the same `handle-support-ticket` trace under the same agent —
what distinguishes a card update from a refund request is the customer's message.
That's exactly what flows are for: a **flow** is a named behaviour with a membership
definition, and it persists across sessions. Create one of each kind (dashboard
**Flows → New flow**, or the CLI):

```sh
# A deterministic selector flow — "card" appears in the card-update messages:
node bin/glassray.mjs flows create --name "Card updates" \
  --description "The customer wants to change the card on file" \
  --selector '{"agent":"support-bot","q":"card","limit":20}'

# A rule-defined flow — refund requests share no substring ("$310 back", "refund
# $45", "charged for gift wrap…"), so let the classify sweep read the intent:
node bin/glassray.mjs flows create --name "Refund requests" \
  --classify llm \
  --rule "The customer is asking for money back on an order (a refund), in any wording"
```

The selector flow materializes its members instantly; the rule flow is picked up by
the **background classify sweep** over the newest traces. `glassray-coach flows list` shows
both with live member counts; `glassray-coach flows get <id>` shows every member with how
it was assigned. (You can also let Coach map flows from the agent's own source code —
**Discover flows** / `glassray-coach flows discover --code-root examples/support-bot` —
then tighten what it finds.)

> Classification is deliberately iterative, and this selector proves it:
> `glassray-coach flows audit <flowId>` shows 4 members — but one is "How do I redeem a
> **gift card**?" (an over-match), while t29 ("Charge my **amex** 3400…") never says
> "card" and slipped through (an under-match). That's the audit's job — spot both,
> then tighten: `glassray-coach flows update <id> --no-selector --classify llm --rule "The
> customer is changing the payment card on file, including by brand name"` (drop the
> substring selector too, or its matches remain active alongside the rule) and the sweep
> re-derives membership from intent instead of substrings. Like discovery, the
> rule-based sweep needs a real model — on `mock` it assigns nothing (selector
> flows still work everywhere).

## 4. Freeze each deviation into a flow-scoped eval

On each deviation, click **Save as eval** and pick its flow — or from the CLI, bind
and tune the autorun threshold in one go (the corpus only lands ~4 tickets per
behaviour per run, under the default threshold of 10):

```sh
node bin/glassray.mjs evals create --deviation <devId> --flow <flowId>
node bin/glassray.mjs evals update <evalId> --autorun-threshold 3

# or hand-write one:
node bin/glassray.mjs evals create --flow <cardFlowId> --autorun-threshold 3 \
  --name "No full card numbers" \
  --text "The reply must never contain a full card number — refer to cards by their last 4 digits only."
```

A flow-scoped eval samples **only that flow's traces** — the card eval never wastes
a judge call on a shipping question. Baseline each one now
(`glassray-coach evals run <id>`): it fails on the buggy corpus, as it should.

## 5. Ship the fix — and watch the loop close itself

```sh
node examples/support-bot/support-bot.mjs --fixed    # same 34 tickets, bugs corrected
```

The fixed agent grounds every order answer in `lookup_order`, escalates over-limit
refunds to a human, and refers to cards by their last 4 digits. This time, **don't
touch anything**: as the fresh traffic lands, Coach classifies it into your flows in
the background, and any flow-scoped eval past its autorun threshold **reruns on its
own**. Watch it happen:

```sh
node bin/glassray.mjs runs list      # classify sweep → autorun eval runs
node bin/glassray.mjs evals list     # pass rates climbed without you touching them
```

The run history shows the trend, and if a later change *reintroduced* a failure that
used to pass, the eval flags it as a **regression**. That ratchet is the whole loop:
discover → scope → codify → and from then on it runs itself. (The same applies when
you switch the agent's model — new traffic classifies into the same flows, the evals
rerun, and the history tells you whether the cheaper model held up.)

## 6. Debug a single call (optional)

Open any trace, select an LLM span, and hit **Replay** — edit the model / system /
prompt and re-issue it through your local LLM, with the fresh output beside the
original. The viewer becomes a debugger.

## 7. Drive the whole loop from your coding agent (optional)

With Coach running, install the agent skill into this repo (Claude Code, Codex, Copilot):

```sh
glassray-coach init          # installs the skill for Claude Code, Codex & Copilot
```

Then everything above becomes something you can simply ask for: *"set up flows and
evals for the support bot from its policy"* (Claude reads `SYSTEM_PROMPT` in
`support-bot.mjs` — the three policy lines are the three evals), *"which traces
echoed a full card number?"*, or *"run discovery and fix what it finds"* — Claude
drives the same flows, deviations, and evals through the `glassray-coach` CLI, and
`glassray-coach fix <deviationId>` hands it repo-ready instructions to apply.

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
5. **Flows → New flow** — create "Card updates" with the `q: card` selector; members
   materialize instantly. "A flow is a durable scope: this behaviour, these traces,
   from now on — new traffic classifies into it in the background."
6. **Back to Deviations** — open each one: the rule, the evidence, the offending
   traces. "Eleven wrong answers. Zero errors. Your error rate never saw them."
7. **Save as eval** on each, bound to its flow (threshold 3), run one for a baseline.
   "The finding is now a test — scoped to exactly the behaviour it's about."
8. Run `--fixed` and **touch nothing** — narrate `glassray-coach runs list` as the classify
   sweep and the autorun eval runs appear, then show the climbing pass rates.
   "Discovery finds it, flows scope it, evals lock it in, and the reruns are
   hands-free. That's the loop."

## Files

| File | Role |
| --- | --- |
| [`support-bot.mjs`](./support-bot.mjs) | The simulated agent (instrumented with `@glassray/tracing`), the 34-ticket corpus, and the runner — `--fixed` turns the bugs off. |

## Reset between runs

`node bin/glassray.mjs reset --yes` wipes the local data dir for a clean slate.
