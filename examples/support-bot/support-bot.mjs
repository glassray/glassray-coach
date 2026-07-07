/*
 * support-bot.mjs — a realistic (simulated) customer-support agent, instrumented
 * with the tracing shim, that emits a *corpus* of traces to a running Coach.
 *
 * The agent's LLM/tool responses are canned (so this runs with no API key and is
 * deterministic) — Coach still does the real work: analyzing the traces. The
 * point is the shape of the corpus. In its default "buggy" mode the agent has
 * three RECURRING failure modes, planted so `Run discovery` has real signal to
 * cluster:
 *
 *   A. Ungrounded order status — answers "where's my order" WITHOUT calling the
 *      lookup tool, inventing a status. (a silent bug: the span is not an error)
 *   B. Unauthorized refund — issues refunds over the $100 policy limit instead of
 *      escalating to a human.
 *   C. PII leak — echoes the customer's full card number back in the reply.
 *
 * Run again with `--fixed` and all three are corrected — so after you save the
 * deviations as evals, a fixed re-run makes their pass rate climb.
 *
 *   node examples/support-bot/support-bot.mjs           # buggy corpus (default)
 *   node examples/support-bot/support-bot.mjs --fixed   # corrected corpus
 *
 * See ./README.md for the full walkthrough.
 */
import { Glassray } from './trace-lite.mjs';

/** Sleep `ms` so spans have realistic, non-zero durations in the waterfall. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A canned LLM step: pauses briefly, then returns Anthropic-shaped content + usage. */
const say = (content, tokensIn, tokensOut) => async () => {
  await sleep(40 + Math.floor(Math.random() * 160));
  return { content, usage: { input_tokens: tokensIn, output_tokens: tokensOut } };
};

/** A canned tool step: pauses briefly, then returns the given output. */
const does = (output) => async () => {
  await sleep(15 + Math.floor(Math.random() * 70));
  return output;
};

/**
 * The support agent. Given one ticket, it emits a trace (agent → llm → tool…)
 * and returns the customer-facing reply. `mode` toggles the planted bugs.
 */
const handleTicket = (g, ticket, mode) => {
  const buggy = mode !== 'fixed';
  const model = 'claude-opus-4-8';
  const provider = 'anthropic';

  return g.trace('handle-support-ticket', { input: ticket.msg, ticket: ticket.id, category: ticket.kind }, async (t) => {
    switch (ticket.kind) {
      // ── A. Order status — must ground the answer in a lookup_order call ──────
      case 'order_status': {
        if (buggy) {
          // BUG A: answer straight from the model, no tool call, invented status.
          const reply = `Your order ${ticket.orderId} is on its way and should arrive in 2–3 business days!`;
          await t.llm('answer', { model, provider, input: ticket.msg }, say(reply, 380, 90));
          return reply;
        }
        await t.llm('plan', { model, provider, input: ticket.msg }, say('The user is asking about order status — look it up.', 360, 40));
        const order = await t.tool('lookup_order', { input: { orderId: ticket.orderId } }, does({ orderId: ticket.orderId, status: 'out_for_delivery', eta: '2026-07-08' }));
        const reply = `Order ${order.orderId} is ${order.status.replace(/_/g, ' ')} — estimated ${order.eta}.`;
        await t.llm('answer', { model, provider, input: JSON.stringify(order) }, say(reply, 520, 80));
        return reply;
      }

      // ── B/refund — refunds over $100 must escalate, not auto-issue ───────────
      case 'refund_large': {
        await t.llm('plan', { model, provider, input: ticket.msg }, say(`Customer requests a $${ticket.amount} refund on ${ticket.orderId}.`, 400, 60));
        if (buggy) {
          // BUG B: issue the over-limit refund with no human approval.
          await t.tool('issue_refund', { input: { orderId: ticket.orderId, amount: ticket.amount } }, does({ ok: true, refunded: ticket.amount }));
          const reply = `Done! I've refunded $${ticket.amount} to your original payment method.`;
          await t.llm('answer', { model, provider }, say(reply, 300, 50));
          return reply;
        }
        const reply = `A $${ticket.amount} refund is above what I can approve directly — I've escalated it to a human agent, who'll confirm within one business day.`;
        await t.llm('answer', { model, provider }, say(reply, 320, 70));
        return reply;
      }

      case 'refund_small': {
        await t.llm('plan', { model, provider, input: ticket.msg }, say(`Small refund ($${ticket.amount}) — within policy.`, 380, 40));
        await t.tool('issue_refund', { input: { orderId: ticket.orderId, amount: ticket.amount } }, does({ ok: true, refunded: ticket.amount }));
        const reply = `All set — $${ticket.amount} has been refunded to your original payment method.`;
        await t.llm('answer', { model, provider }, say(reply, 300, 50));
        return reply;
      }

      // ── C/PII — never echo a full card number ────────────────────────────────
      case 'pii': {
        const last4 = ticket.card.slice(-4);
        if (buggy) {
          // BUG C: reflect the raw card number straight back to the customer.
          const reply = `Thanks — I've noted the card ${ticket.card} on your account and updated your billing.`;
          await t.llm('answer', { model, provider, input: ticket.msg }, say(reply, 340, 60));
          return reply;
        }
        const reply = `Thanks — I've updated the card ending ${last4} on your account. (For your security, please don't share full card numbers in chat.)`;
        await t.llm('answer', { model, provider, input: ticket.msg }, say(reply, 340, 70));
        return reply;
      }

      // ── Clean paths: KB questions + greetings ────────────────────────────────
      case 'kb': {
        const kb = await t.tool('search_kb', { input: { query: ticket.msg } }, does({ hits: [ticket.answer] }));
        const reply = kb.hits[0];
        await t.llm('answer', { model, provider, input: JSON.stringify(kb) }, say(reply, 500, 90));
        return reply;
      }

      default: {
        const reply = 'Hi! Thanks for reaching out — how can I help you today?';
        await t.llm('answer', { model, provider, input: ticket.msg }, say(reply, 120, 30));
        return reply;
      }
    }
  });
};

/** The ticket corpus: ~26 realistic messages spanning clean paths + the three planted bugs. */
const TICKETS = [
  // order_status (×7) — buggy mode invents a status with no lookup_order
  { id: 't01', kind: 'order_status', orderId: '4821', msg: 'Where is my order #4821? It was supposed to arrive yesterday.' },
  { id: 't02', kind: 'order_status', orderId: '5567', msg: 'Has order 5567 shipped yet?' },
  { id: 't03', kind: 'order_status', orderId: '6012', msg: 'Any update on my delivery for order 6012?' },
  { id: 't04', kind: 'order_status', orderId: '6190', msg: 'I still have not received order #6190 — whats going on?' },
  { id: 't05', kind: 'order_status', orderId: '7233', msg: 'When will order 7233 get here?' },
  { id: 't06', kind: 'order_status', orderId: '7788', msg: 'Tracking for order 7788 says nothing. Status?' },
  { id: 't07', kind: 'order_status', orderId: '8041', msg: 'Is my order 8041 out for delivery today?' },

  // refund_large (×4, > $100) — buggy mode auto-issues instead of escalating
  { id: 't08', kind: 'refund_large', orderId: '4821', amount: 240, msg: 'I want a full refund of $240 for order 4821, it arrived broken.' },
  { id: 't09', kind: 'refund_large', orderId: '5567', amount: 175, msg: 'Please refund $175 for order 5567.' },
  { id: 't10', kind: 'refund_large', orderId: '9001', amount: 520, msg: 'Refund the whole $520 order 9001 — I never got it.' },
  { id: 't11', kind: 'refund_large', orderId: '9110', amount: 130, msg: 'I need $130 back for order 9110.' },

  // refund_small (×2, <= $100) — clean in both modes
  { id: 't12', kind: 'refund_small', orderId: '3300', amount: 20, msg: 'Can I get a $20 refund for the shipping on order 3300?' },
  { id: 't13', kind: 'refund_small', orderId: '3450', amount: 45, msg: 'Please refund $45 for the damaged item in order 3450.' },

  // pii (×3) — buggy mode echoes the full card number
  { id: 't14', kind: 'pii', card: '4111111111111111', msg: 'Update my card to 4111111111111111 please.' },
  { id: 't15', kind: 'pii', card: '5500005555555559', msg: 'My new card is 5500005555555559, use that going forward.' },
  { id: 't16', kind: 'pii', card: '340000000000009', msg: 'Charge my amex 340000000000009 for the reorder.' },

  // kb (×7) — clean
  { id: 't17', kind: 'kb', msg: 'What is your return window?', answer: 'You can return most items within 30 days of delivery.' },
  { id: 't18', kind: 'kb', msg: 'Do you ship internationally?', answer: 'Yes — we ship to 40+ countries; duties are calculated at checkout.' },
  { id: 't19', kind: 'kb', msg: 'How do I change my shipping address?', answer: 'You can edit the address on an unshipped order from Order → Edit.' },
  { id: 't20', kind: 'kb', msg: 'What payment methods do you accept?', answer: 'We accept all major cards, Apple Pay, and Google Pay.' },
  { id: 't21', kind: 'kb', msg: 'Is there a warranty on electronics?', answer: 'Electronics carry a 1-year limited manufacturer warranty.' },
  { id: 't22', kind: 'kb', msg: 'How long does standard shipping take?', answer: 'Standard shipping is 3–5 business days within the US.' },
  { id: 't23', kind: 'kb', msg: 'Can I use two discount codes?', answer: 'Only one discount code can be applied per order.' },

  // greeting (×3) — clean
  { id: 't24', kind: 'greeting', msg: 'Hi there!' },
  { id: 't25', kind: 'greeting', msg: 'Hello, anyone available?' },
  { id: 't26', kind: 'greeting', msg: 'Hey 👋' },
];

/** Run the whole corpus through the agent and report what landed. */
const main = async () => {
  const mode = process.argv.includes('--fixed') ? 'fixed' : 'buggy';
  const g = new Glassray({ agent: 'support-bot', environment: 'local' });

  console.log(`Sending ${TICKETS.length} support tickets through the "${mode}" agent → ${g.base}\n`);
  let ok = 0;
  for (const ticket of TICKETS) {
    try {
      await handleTicket(g, ticket, mode);
      ok += 1;
      process.stdout.write('.');
    } catch (err) {
      process.stdout.write('x');
      console.error(`\n  ${ticket.id} failed:`, err.message);
    }
  }
  await g.flush();

  console.log(`\n\n✓ sent ${ok}/${TICKETS.length} traces (${mode} mode).`);
  if (mode === 'buggy') {
    console.log('\nNext: open http://127.0.0.1:5899 → Deviations → Run discovery.');
    console.log('Discovery should cluster three recurring deviations:');
    console.log('  • order-status answers with no lookup_order call (invented status)');
    console.log('  • refunds over the $100 limit issued without escalation');
    console.log('  • full card numbers echoed back to the customer');
    console.log('Save each as an eval, then re-run me with --fixed and re-run the evals.');
  } else {
    console.log('\nNext: re-run your saved evals (Evals → each → Re-run) — the pass rate should climb.');
  }
};

main().catch((err) => {
  console.error('\n✗', err.message);
  process.exit(1);
});
