// Text bounding shared by the core and adapters. Model text is data: flatten it, strip fences, bound the length.

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const oneLine = (s: string, n: number): string => clip(s.replace(/[\r\n]+/g, ' '), n);

const MAX_NARRATIVE_CHARS = 700;

/** Model text is data: flatten, strip code fences/backticks, bound the length. */
export function cleanNarrative(text: string | undefined): string {
  if (!text) return '';
  return clip(text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, ''), MAX_NARRATIVE_CHARS);
}
