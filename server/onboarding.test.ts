import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from './onboarding.js';

describe('buildAgentPrompt', () => {
  const input = {
    ingestEndpoint: 'http://127.0.0.1:5899/v1/traces',
    apiKey: 'glsk_local_' + 'a'.repeat(48),
  };

  it('bakes the live endpoint and key into the prompt', () => {
    const prompt = buildAgentPrompt(input);
    expect(prompt).toContain(input.ingestEndpoint);
    expect(prompt).toContain(input.apiKey);
  });

  it('walks the agent through init → verify server → discover → instrument → verify', () => {
    const prompt = buildAgentPrompt(input);
    expect(prompt).toContain('npx @glassray/coach init');
    // The stale-header gate: verify the server before doing anything.
    expect(prompt).toContain('npx @glassray/coach status');
    expect(prompt).toContain('STOP');
    // Discovery is delegated to the server's code explorer, not re-derived.
    expect(prompt).toContain('flows discover --code-root');
    expect(prompt).toContain('@glassray/tracing');
    expect(prompt).toContain('http/json');
    expect(prompt).toContain('traces list');
    // The four tags every trace must carry.
    expect(prompt).toContain('agent, environment, customer, and flow');
    // Server state is snapshotted to git, and coverage must be reported.
    expect(prompt).toContain('pull');
    expect(prompt).toContain('coverage report');
  });

  it('is plain text an agent can be handed verbatim — no ANSI escapes', () => {
    expect(buildAgentPrompt(input)).not.toContain('\u001b');
  });
});
