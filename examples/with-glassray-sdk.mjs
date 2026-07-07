#!/usr/bin/env node
/*
 * with-glassray-sdk.mjs — the same trace as send-otlp.mjs, but produced by the
 * real @glassray/tracing SDK instead of hand-built OTLP. This is how you'd
 * actually instrument an agent; the SDK handles OTLP encoding, gzip, batching,
 * and retries for you.
 *
 * Requires the SDK (`@glassray/tracing`, now on npm):
 *   npm install @glassray/tracing
 *
 * Then, with Coach running (`node bin/glassray.mjs`):
 *   GLASSRAY_API_KEY=$(curl -s http://127.0.0.1:5899/api/info | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).apiKey))') \
 *   GLASSRAY_ENDPOINT=http://127.0.0.1:5899 \
 *   node examples/with-glassray-sdk.mjs
 */

import { Glassray } from '@glassray/tracing';

// The SDK defaults to Glassray Cloud — GLASSRAY_ENDPOINT points it at local Coach.
const glassray = new Glassray({ environment: 'local', agent: 'support-agent' });

/** Stand-in for a real LLM call — returns an Anthropic-shaped response so the SDK captures tokens. */
const fakeLlm = async () => ({
  content: 'Let me look up order #4821 for you.',
  usage: { input_tokens: 1240, output_tokens: 320 },
});

/** Stand-in for a real tool call. */
const lookupOrder = async (orderId) => ({ orderId, status: 'out_for_delivery', shippedAt: '2026-07-01' });

await glassray.trace('handle-support-ticket', { customer: 'acme' }, async (t) => {
  const reply = await t.llm(
    'chat',
    { model: 'claude-opus-4-8', provider: 'anthropic' },
    () => fakeLlm(),
  );
  const order = await t.tool('lookup-order', () => lookupOrder('4821'));
  return { reply, order };
});

// Serverless: `waitUntil(glassray.flush())`. Long-lived processes flush on exit,
// but flushing explicitly guarantees delivery before this script returns.
await glassray.flush();
console.log('✓ sent 1 trace via @glassray/tracing —', JSON.stringify(glassray.stats()));
console.log('  open the Coach dashboard to see the AGENT → LLM → TOOL waterfall.');
