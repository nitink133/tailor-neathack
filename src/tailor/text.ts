// Text bounding shared by the core and adapters. Model text is data: normalise it, flatten it, de-fence it, bound it.

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const oneLine = (s: string, n: number): string => clip(s.replace(/[\r\n]+/g, ' '), n);

const MAX_NARRATIVE_CHARS = 700;

/**
 * Unicode NFKC: full-width digits ("３"), circled numbers, ligatures and compatibility letters become their plain forms
 * BEFORE any claim or number check, so look-alike characters cannot slip past ASCII-only patterns.
 */
export function normaliseProse(text: string): string {
  return text.normalize('NFKC');
}

/**
 * Markdown code fences keep their content, which is then grounded like any other sentence; the fence and a language tag
 * on its own line go. The content ends as its own sentence so it is judged apart from the prose around it.
 */
export function defence(text: string): string {
  return text.replace(/```(?:[A-Za-z0-9_+-]*[^\S\n]*\n)?([\s\S]*?)```/g, (_m, inner: string) => {
    const t = inner.trim();
    return t ? ` ${t}${/[.!?]$/.test(t) ? '' : '.'} ` : ' ';
  }).replace(/`/g, '');
}

/** Model text is data: NFKC-normalise, de-fence, flatten, bound the length. */
export function cleanNarrative(text: string | undefined): string {
  if (!text) return '';
  return clip(defence(normaliseProse(text)), MAX_NARRATIVE_CHARS);
}
