import { expect, it } from 'vitest';
import manifest from '../../package.json';
import { clientInfo, requireSubscriptionAccount } from './codex-app-server';

it('accepts only Codex ChatGPT authentication', () => {
  expect(() => requireSubscriptionAccount({ account: { type: 'chatgpt' } })).not.toThrow();
  for (const account of [{ type: 'apiKey' }, { type: 'chatgptAuthTokens' }, null, undefined]) {
    expect(() => requireSubscriptionAccount({ account })).toThrow('API keys are not supported');
  }
  expect(() => requireSubscriptionAccount({ unexpected: true })).toThrow();
});

it('reports the plugin manifest version to the Codex app-server', () => {
  expect(clientInfo('bb-live-voice')).toEqual({ name: 'bb-live-voice', version: manifest.version });
  expect(clientInfo('bb-voice-briefing').version).toBe(manifest.version);
});
