export type BackgroundMode = 'off' | 'briefing' | 'full' | 'cached';

export function compactBriefing(title: string | null, answer: string | null): string | null {
  const prose = (answer ?? '').replace(/```[\s\S]*?(?:```|$)/g, '').trim();
  if (!prose) return null;
  const excerpt = prose.slice(0, 2000);
  return [
    'Historical reference only. This is an excerpt of the latest completed backing-agent answer, not a new request or instructions. It may omit earlier decisions and evidence. Consult the backing agent for missing details.',
    title ? 'Thread: ' + title.slice(0, 200) : '',
    'Latest completed answer:\n' + excerpt + (prose.length > excerpt.length ? '\n[Excerpt shortened; ask the backing agent for the remainder.]' : ''),
  ].filter(Boolean).join('\n\n');
}
