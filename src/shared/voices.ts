import { z } from 'zod';

export const voiceNames = ['arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale'] as const;
export const voiceSchema = z.enum(voiceNames);
export type Voice = z.infer<typeof voiceSchema>;
export const voiceSettingSchema = z.enum(['default', ...voiceNames]);
export function selectedVoice(value: unknown): Voice | undefined {
  const choice = voiceSettingSchema.parse(value ?? 'default');
  return choice === 'default' ? undefined : choice;
}
