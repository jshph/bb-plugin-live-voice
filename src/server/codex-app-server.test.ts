import { expect, it } from 'vitest';
import { requireSubscriptionAccount } from './codex-app-server';

it('accepts only Codex ChatGPT authentication', () => {
  expect(() => requireSubscriptionAccount({ account: { type: 'chatgpt' } })).not.toThrow();
  for (const account of [{ type: 'apiKey' }, { type: 'chatgptAuthTokens' }, null, undefined]) {
    expect(() => requireSubscriptionAccount({ account })).toThrow('API keys are not supported');
  }
  expect(() => requireSubscriptionAccount({ unexpected: true })).toThrow();
});
