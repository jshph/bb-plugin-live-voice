import { z } from 'zod';

export const spokenTurnSchema = z.object({
  seq: z.number().int().positive().max(1000000),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(16000),
  complete: z.boolean(),
  truncated: z.boolean().optional(),
});
export type SpokenTurn = z.infer<typeof spokenTurnSchema>;

export function normalized(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
