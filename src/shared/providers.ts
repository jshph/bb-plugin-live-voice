/** BB coding providers that Tandem can attach a voice call to. Codex uses native voice; the others use Claude delegation. */
export const voiceProviderIds = ['codex', 'claude-code', 'claude'] as const;

export function supportsVoice(providerId: string | undefined): boolean {
  return providerId !== undefined && (voiceProviderIds as readonly string[]).includes(providerId);
}
