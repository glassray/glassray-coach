#!/usr/bin/env node
/*
 * support-bot.mjs — a simulated customer-support agent for the fictional store
 * "Nimbus Outfitters", instrumented with the real @glassray/tracing SDK, that
 * sends a realistic corpus of traffic to a running Glassray Coach.
 *
 * The agent's LLM/tool responses are canned, so this runs with no API key and
 * is deterministic — Coach still does the real work: analyzing the traces.
 * The instrumentation, however, is exactly what you'd ship: the import below
 * is the same `@glassray/tracing` package a production agent uses.
 *
 * In its default "buggy" mode the agent has three RECURRING, SILENT failure
 * modes — wrong answers that are not errors, so every dashboard stays green:
 *
 *   A. Ungrounded order status — sometimes answers "where's my order" WITHOUT
 *      calling lookup_order, inventing a status. (5 of 8 order tickets)
 *   B. Unauthorized refund — sometimes issues refunds over the $100 policy
 *      limit instead of escalating to a human. (3 of 5 large refunds)
 *   C. PII leak — sometimes echoes the customer's full card number back in
 *      the reply. (3 of 4 card updates)
 *
 * The bugs are intermittent (per-ticket), the way real agent failures are.
 * The corpus also includes ordinary messy traffic: a knowledge-base timeout
 * the agent recovers from, one hard failure (billing service down), an
 * 18k-token outlier, and two multi-tool waterfalls.
 *
 * Run again with `--fixed` and the three bugs are corrected — so after you
 * save the discovered deviations as evals, a fixed re-run makes their pass
 * rate climb.
 *
 *   node examples/support-bot/support-bot.mjs           # buggy corpus (default)
 *   node examples/support-bot/support-bot.mjs --fixed   # corrected corpus
 *
 * See ./README.md for the full walkthrough (and a 5-minute demo script).
 */
import { Glassray } from '@glassray/tracing';

/** The model the agent "uses" for drafting customer replies. */
const ANSWER_MODEL = 'claude-opus-4-8';
/** The cheaper model the agent "uses" for routing/planning steps. */
const PLAN_MODEL = 'claude-sonnet-4-6';

/** The agent's system prompt — the policy the buggy mode silently violates. */
const SYSTEM_PROMPT = [
  'You are the Nimbus Outfitters customer-support agent.',
  'Policy:',
  '- Ground every order-status answer in a lookup_order call. Never guess or invent shipping status.',
  '- Refunds up to $100: issue directly with issue_refund. Anything larger: escalate_to_human. Never self-approve.',
  '- Never repeat a full card number back to the customer. Refer to cards by their last 4 digits only.',
].join('\n');

/** Sleep `ms` so spans get realistic, non-zero durations in the waterfall. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random integer in [lo, hi) — latency jitter only; trace *content* stays deterministic. */
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

/**
 * A canned LLM step: waits a realistic beat, then returns an Anthropic
 * Messages-shaped response — so the SDK captures text + token usage exactly
 * as it would from a real API call.
 */
const llmReply = (text, inputTokens, outputTokens, ms) => async () => {
  await sleep(ms ?? jitter(60, 190));
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
};

/** A canned tool step: waits a beat, then returns the given output. */
const toolResult = (output) => async () => {
  await sleep(jitter(20, 90));
  return output;
};

/** A canned tool failure: waits (like a timing-out call), then throws. */
const toolFail = (message) => async () => {
  await sleep(jitter(150, 400));
  throw new Error(message);
};

/** The text content of a canned LLM response. */
const textOf = (res) => res.content.map((b) => b.text).join('');

/** Chat-shaped LLM input: system policy + the customer message (+ an optional tool-result turn). */
const chat = (msg, context) => ({
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: msg },
    ...(context ? [{ role: 'user', content: `[tool result] ${JSON.stringify(context)}` }] : []),
  ],
});

/**
 * The support agent. Given one ticket, it emits a trace (agent → llm → tool…)
 * and returns the customer-facing reply. In buggy mode, tickets flagged
 * `bug: true` misbehave; in fixed mode every ticket follows policy.
 */
const handleTicket = (glassray, ticket, mode) => {
  const misbehave = mode === 'buggy' && ticket.bug === true;
  // Small deterministic token variance so the corpus doesn't look copy-pasted.
  const v = ticket.msg.length % 57;

  return glassray.trace('handle-support-ticket', { customer: ticket.customer }, async (t) => {
    t.setInput(ticket.msg);

    switch (ticket.kind) {
      // ── A. Order status — must be grounded in a lookup_order call ──────────
      case 'order_status': {
        if (misbehave) {
          // BUG A: answer straight from the model — no tool call, invented status.
          const res = await t.llm(
            'draft reply',
            { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
            llmReply(ticket.invented, 402 + v, 81),
          );
          return textOf(res);
        }
        await t.llm(
          'plan',
          { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply(`Order-status question about #${ticket.orderId} — look it up before answering.`, 371 + v, 38),
        );
        const order = await t.tool(
          'lookup_order',
          { input: { orderId: ticket.orderId } },
          toolResult({ orderId: ticket.orderId, status: ticket.status, eta: ticket.eta }),
        );
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, order) },
          llmReply(`Order #${order.orderId} is ${order.status.replace(/_/g, ' ')} — estimated delivery ${order.eta}.`, 534 + v, 72),
        );
        return textOf(res);
      }

      // ── B. Refunds — over $100 must escalate, never self-approve ───────────
      case 'refund_large': {
        if (misbehave) {
          // BUG B: issue the over-limit refund with no human approval.
          await t.llm(
            'plan',
            { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
            llmReply(`Customer wants a $${ticket.amount} refund on #${ticket.orderId} — process it.`, 389 + v, 44),
          );
          await t.tool(
            'issue_refund',
            { input: { orderId: ticket.orderId, amount: ticket.amount } },
            toolResult({ ok: true, refunded: ticket.amount }),
          );
          const res = await t.llm(
            'draft reply',
            { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
            llmReply(`Done! I've refunded $${ticket.amount} to your original payment method — you'll see it within 3–5 business days.`, 448 + v, 58),
          );
          return textOf(res);
        }
        await t.llm(
          'plan',
          { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply(`$${ticket.amount} exceeds the $100 self-approval limit — escalate to a human.`, 389 + v, 46),
        );
        const esc = await t.tool(
          'escalate_to_human',
          { input: { orderId: ticket.orderId, amount: ticket.amount, reason: 'refund over self-approval limit' } },
          toolResult({ queued: true, caseId: `case-${ticket.orderId}` }),
        );
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, esc) },
          llmReply(`A $${ticket.amount} refund is above what I can approve directly, so I've escalated it (case ${esc.caseId}) — a teammate will confirm within one business day.`, 471 + v, 77),
        );
        return textOf(res);
      }

      case 'refund_small': {
        await t.llm(
          'plan',
          { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply(`Small refund ($${ticket.amount}) — within policy, issue it.`, 366 + v, 34),
        );
        const refund = await t.tool(
          'issue_refund',
          { input: { orderId: ticket.orderId, amount: ticket.amount } },
          toolResult({ ok: true, refunded: ticket.amount }),
        );
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, refund) },
          llmReply(`All set — $${ticket.amount} is on its way back to your original payment method.`, 431 + v, 52),
        );
        return textOf(res);
      }

      // ── C. Card updates — never echo a full card number ────────────────────
      case 'card_update': {
        const last4 = ticket.card.slice(-4);
        const upd = await t.tool(
          'update_payment_method',
          { input: { cardLast4: last4 } },
          toolResult({ ok: true, cardLast4: last4 }),
        );
        // BUG C: the update itself works — the *reply* reflects the raw card number.
        const reply = misbehave
          ? `All set — I've updated your payment method to card ${ticket.card}. Your next order will charge that card.`
          : `All set — I've updated your payment method to the card ending in ${last4}. (Tip: for your security, avoid sharing full card numbers in chat.)`;
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, upd) },
          llmReply(reply, 418 + v, 64),
        );
        return textOf(res);
      }

      // ── Knowledge-base questions (one has a KB outage the agent recovers from) ──
      case 'kb': {
        let kb;
        try {
          kb = await t.tool(
            'search_kb',
            { input: { query: ticket.msg } },
            ticket.fail ? toolFail('knowledge base timeout after 3000ms') : toolResult({ hits: [ticket.answer] }),
          );
        } catch {
          const res = await t.llm(
            'draft reply',
            { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, { error: 'search_kb timed out' }) },
            llmReply("I'm having trouble reaching our help center right now — mind trying again in a few minutes? If it's urgent, reply here and I'll flag it for a teammate.", 455 + v, 61),
          );
          return textOf(res);
        }
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, kb) },
          llmReply(kb.hits[0], 508 + v, 84),
        );
        return textOf(res);
      }

      // ── Multi-tool path: damaged/wrong item → verify, check policy, refund ──
      case 'damaged_item': {
        await t.llm(
          'plan',
          { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply('Damaged/wrong item — verify the order, check return policy, refund if eligible.', 397 + v, 49),
        );
        const order = await t.tool(
          'lookup_order',
          { input: { orderId: ticket.orderId } },
          toolResult({ orderId: ticket.orderId, status: 'delivered', deliveredAt: ticket.deliveredAt }),
        );
        const policy = await t.tool(
          'check_return_policy',
          { input: { orderId: ticket.orderId, reason: ticket.reason } },
          toolResult({ eligible: true, window: '30 days', refundable: ticket.amount }),
        );
        await t.tool(
          'issue_refund',
          { input: { orderId: ticket.orderId, amount: ticket.amount } },
          toolResult({ ok: true, refunded: ticket.amount }),
        );
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg, { order, policy }) },
          llmReply(`So sorry about that! I've refunded $${ticket.amount} for the ${ticket.reason} item on order #${ticket.orderId} — you'll see it in 3–5 business days. No need to ship it back.`, 663 + v, 95),
        );
        return textOf(res);
      }

      // ── Billing lookup — the backing service is down; this one hard-fails ──
      case 'billing': {
        await t.llm(
          'plan',
          { model: PLAN_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply('Possible double charge — pull the invoice before promising anything.', 384 + v, 41),
        );
        // No catch on purpose: the failure propagates, the trace records a real error.
        await t.tool(
          'get_invoice',
          { input: { orderId: ticket.orderId } },
          toolFail('billing service timeout after 3000ms'),
        );
        return 'unreachable';
      }

      // ── The outlier: a pasted email thread → one huge, slow LLM call ───────
      case 'long_thread': {
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply("Thanks for the full thread — that helped. I've updated the delivery address on order #7719 to 44 Harbor Lane, and your replacement ships tomorrow with 2-day shipping at no charge. I've also credited the $12 shipping fee from the original order.", 18_432, 342, 2_600),
        );
        return textOf(res);
      }

      // ── Small talk ──────────────────────────────────────────────────────────
      default: {
        const res = await t.llm(
          'draft reply',
          { model: ANSWER_MODEL, provider: 'anthropic', input: chat(ticket.msg) },
          llmReply(ticket.reply ?? 'Hi! Thanks for reaching out — how can I help you today?', 128 + v, 26),
        );
        return textOf(res);
      }
    }
  });
};

/**
 * The ticket corpus: 34 realistic messages, deliberately interleaved the way
 * real traffic arrives. `bug: true` marks the tickets where the buggy agent
 * misbehaves (bugs are intermittent — some tickets in each risky category go
 * fine even in buggy mode).
 */
const TICKETS = [
  { id: 't01', kind: 'greeting', customer: 'maya.p', msg: 'Hey, anyone there?' },
  { id: 't02', kind: 'order_status', bug: true, customer: 'jbecker', orderId: '4821', status: 'out_for_delivery', eta: '2026-07-07', msg: 'Where is my order #4821? It was supposed to arrive yesterday.', invented: "Good news — order #4821 is out for delivery and should reach you by end of day today!" },
  { id: 't03', kind: 'kb', customer: 'sofia.r', msg: 'What is your return window?', answer: 'You can return most items within 30 days of delivery for a full refund.' },
  { id: 't04', kind: 'refund_large', bug: true, customer: 'liu.wei', orderId: '5567', amount: 240, msg: 'I want a full refund of $240 for order 5567, it arrived completely broken.' },
  { id: 't05', kind: 'order_status', customer: 'dana.s', orderId: '6012', status: 'in_transit', eta: '2026-07-09', msg: 'Any update on my delivery for order 6012?' },
  { id: 't06', kind: 'card_update', bug: true, customer: 'm.okafor', card: '4111111111111111', msg: 'Update my card to 4111111111111111 please.' },
  { id: 't07', kind: 'kb', customer: 'tom.h', msg: 'Do you ship internationally?', answer: 'Yes — we ship to 40+ countries; duties are calculated at checkout.' },
  { id: 't08', kind: 'refund_small', customer: 'a.silva', orderId: '3300', amount: 20, msg: 'Can I get a $20 refund for the shipping on order 3300? It came late.' },
  { id: 't09', kind: 'order_status', bug: true, customer: 'priya.n', orderId: '6190', status: 'in_transit', eta: '2026-07-10', msg: "I still have not received order #6190 — whats going on??", invented: "I checked and order #6190 is on its way — expect it within 2–3 business days!" },
  { id: 't10', kind: 'damaged_item', customer: 'kwatts', orderId: '7104', amount: 45, reason: 'damaged', deliveredAt: '2026-07-03', msg: 'The mug in order 7104 arrived shattered :( can I get my money back?' },
  { id: 't11', kind: 'kb', fail: true, customer: 'r.tanaka', msg: 'How do I redeem a gift card?', answer: 'Enter the gift-card code at checkout under "Payment".' },
  { id: 't12', kind: 'refund_large', customer: 'noel.b', orderId: '8402', amount: 310, msg: 'Order 8402 never arrived. I paid $310 and I want it back.' },
  { id: 't13', kind: 'order_status', bug: true, customer: 'chloe.m', orderId: '7233', status: 'in_transit', eta: '2026-07-10', msg: 'When will order 7233 get here? Party is Saturday.', invented: "Order #7233 is scheduled to arrive by Friday, so you'll have it in time for the weekend!" },
  { id: 't14', kind: 'kb', customer: 'd.fernandez', msg: 'How do I change my shipping address?', answer: 'You can edit the address on any unshipped order from Orders → Edit.' },
  { id: 't15', kind: 'card_update', customer: 'grace.l', card: '6011000990139424', msg: 'my card expired, new number is 6011000990139424' },
  { id: 't16', kind: 'greeting', customer: 'sam.v', msg: 'quick q — am I talking to a real person?', reply: "I'm Nimbus's support assistant (an AI) — but I can loop in a human teammate anytime. What can I help with?" },
  { id: 't17', kind: 'refund_large', bug: true, customer: 'h.abadi', orderId: '9001', amount: 520, msg: 'Refund the whole $520 for order 9001 — I never got it and support has been useless.' },
  { id: 't18', kind: 'order_status', customer: 'jonah.k', orderId: '7788', status: 'processing', eta: '2026-07-11', msg: 'Tracking for order 7788 shows nothing. Status?' },
  { id: 't19', kind: 'kb', customer: 'iris.w', msg: 'What payment methods do you accept?', answer: 'We accept all major cards, Apple Pay, and Google Pay.' },
  { id: 't20', kind: 'long_thread', customer: 'f.moreau', msg: ['Fwd: Fwd: RE: order mixup — please read the whole thread before replying', '', '> From: fulfillment@nimbus', '> The replacement for #7719 shipped to the OLD address on file.', '>> From: felix', '>> I moved in June — I updated my address in my account settings on the 2nd.', '>>> From: support', '>>> We show 12 Cedar Ct as the delivery address, is that correct?', '>>>> From: felix', '>>>> No!! That is the old place. New address is 44 Harbor Lane.', '', '…(18 more messages trimmed)…', '', 'So to be clear: I need the replacement sent to 44 Harbor Lane, and I should not be paying shipping twice.'].join('\n') },
  { id: 't21', kind: 'order_status', bug: true, customer: 'z.ali', orderId: '8041', status: 'out_for_delivery', eta: '2026-07-07', msg: 'Is my order 8041 out for delivery today?', invented: 'Yes! Order #8041 is out for delivery and should arrive before 8pm tonight.' },
  { id: 't22', kind: 'refund_small', customer: 'beth.c', orderId: '3450', amount: 45, msg: 'Please refund $45 for the damaged candle set in order 3450.' },
  { id: 't23', kind: 'card_update', bug: true, customer: 'o.novak', card: '5500005555555559', msg: 'My new card is 5500005555555559, use that going forward.' },
  { id: 't24', kind: 'kb', customer: 'will.g', msg: 'Is there a warranty on electronics?', answer: 'Electronics carry a 1-year limited manufacturer warranty.' },
  { id: 't25', kind: 'refund_large', bug: true, customer: 'elena.d', orderId: '9110', amount: 175, msg: 'I need $175 back for order 9110. The jacket is nothing like the photos.' },
  { id: 't26', kind: 'billing', customer: 'p.sandoval', orderId: '7710', msg: 'I was double-charged for order 7710!! Fix this NOW or I dispute it with my bank.' },
  { id: 't27', kind: 'order_status', customer: 'amara.j', orderId: '8630', status: 'delivered', eta: '2026-07-05', msg: 'Did order 8630 get delivered? The tracking page 404s for me.' },
  { id: 't28', kind: 'damaged_item', customer: 'ted.b', orderId: '7451', amount: 30, reason: 'wrong', deliveredAt: '2026-07-04', msg: 'You sent me the wrong size in order 7451 — I ordered a medium, got an XL.' },
  { id: 't29', kind: 'card_update', bug: true, customer: 'n.laurent', card: '340000000000009', msg: 'Charge my amex 340000000000009 for the reorder we discussed.' },
  { id: 't30', kind: 'kb', customer: 'yuki.s', msg: 'How long does standard shipping take?', answer: 'Standard shipping is 3–5 business days within the US.' },
  { id: 't31', kind: 'order_status', bug: true, customer: 'gharris', orderId: '9224', status: 'in_transit', eta: '2026-07-08', msg: 'ETA on order 9224? I need it before I travel Thursday.', invented: "Order #9224 will arrive Wednesday — you'll have it before your trip!" },
  { id: 't32', kind: 'refund_large', customer: 'v.petrov', orderId: '9310', amount: 189, msg: 'The desk arrived with a cracked leg. $189 back please, or send a new one.' },
  { id: 't33', kind: 'refund_small', customer: 'lucy.t', orderId: '3721', amount: 15, msg: 'I was charged $15 for gift wrap I never selected on order 3721.' },
  { id: 't34', kind: 'greeting', customer: 'maya.p', msg: "thanks, that's everything!", reply: "Anytime! If anything else comes up, we're right here. Have a great day!" },
];

/** Resolve the ingest key: env override, else auto-discover from the local Coach's /api/info. */
const resolveKey = async (base) => {
  if (process.env.GLASSRAY_API_KEY) return process.env.GLASSRAY_API_KEY;
  const res = await fetch(`${base}/api/info`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`Coach not reachable at ${base} — start it with \`npx @glassray/coach start\` (or set GLASSRAY_ENDPOINT).`);
  }
  return (await res.json()).apiKey;
};

/** Run the whole corpus through the agent and narrate what landed. */
const main = async () => {
  const mode = process.argv.includes('--fixed') ? 'fixed' : 'buggy';
  const base = (process.env.GLASSRAY_ENDPOINT ?? 'http://127.0.0.1:5899').replace(/\/v1\/traces$|\/+$/g, '');
  const glassray = new Glassray({
    agent: 'support-bot',
    environment: 'local',
    endpoint: base,
    apiKey: await resolveKey(base),
  });

  console.log(`Nimbus Outfitters support-bot — ${TICKETS.length} tickets → ${mode.toUpperCase()} agent → ${base}\n`);
  let replied = 0;
  const crashes = [];
  for (const ticket of TICKETS) {
    try {
      await handleTicket(glassray, ticket, mode);
      replied += 1;
      process.stdout.write('.');
    } catch (err) {
      crashes.push(`${ticket.id}: ${err?.message ?? err}`);
      process.stdout.write('x');
    }
  }
  await glassray.flush();

  console.log(`\n\n✓ ${replied} tickets answered, ${crashes.length} crashed — the crash is a trace too:`);
  for (const c of crashes) console.log(`    ${c}`);
  if (mode === 'buggy') {
    console.log(`
Open ${base} and look around:
  Overview   ${TICKETS.length} traces, ~97% success — the dashboards look healthy.
  Traces     agent → llm → tool waterfalls; sort by tokens to find the 18k-token outlier.

But 11 of those "successful" replies are wrong. Nothing errored — the failures are semantic.

Next: Deviations → Run discovery. It should cluster three recurring failure modes:
  • order-status answers invented with no lookup_order call
  • refunds over the $100 policy limit issued without escalation
  • full card numbers echoed back to the customer
Scope the behaviours as flows (README §3), save each deviation as a flow-scoped eval
with an autorun threshold of 3, baseline the evals — then re-run me with --fixed and
touch nothing: the fresh traffic classifies into your flows and the evals rerun on
their own.`);
  } else {
    console.log(`
Next: nothing — Coach is classifying these traces into your flows in the background
(watch \`glassray runs list\`), and flow-scoped evals past their autorun threshold
rerun on their own. Check \`glassray evals list\` (or the Evals page): the pass rates
climb. A change that reintroduced an old failure would be flagged as a regression
instead.`);
  }
};

main().catch((err) => {
  console.error('\n✗', err.message);
  process.exit(1);
});
