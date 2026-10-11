// Delimited message framing shared by the core and providers.
// The framing is one-line JSON (newlines inside strings are escaped), so buyer text can never forge a delimiter line.

export const CONTEXT_BEGIN = 'CONTEXT_JSON_BEGIN';
export const CONTEXT_END = 'CONTEXT_JSON_END';
export const BUYER_TEXT_BEGIN = 'BUYER_TEXT_BEGIN';
export const REPAIR_BEGIN = 'REPAIR_REQUEST';

export function userMessage(context: unknown, buyerText: string): string {
  return `${CONTEXT_BEGIN}\n${JSON.stringify(context)}\n${CONTEXT_END}\n${BUYER_TEXT_BEGIN}\n${buyerText}`;
}

/** Inverse of `userMessage`. Returns null when the content is not in the Tailor framing. */
export function parseUserMessage<TContext = unknown>(content: string): { context: TContext; buyerText: string } | null {
  const head = `${CONTEXT_BEGIN}\n`;
  if (!content.startsWith(head)) return null;
  const newline = content.indexOf('\n', head.length);
  if (newline < 0) return null;
  const json = content.slice(head.length, newline);
  const rest = content.slice(newline + 1);
  const tail = `${CONTEXT_END}\n${BUYER_TEXT_BEGIN}\n`;
  if (!rest.startsWith(tail)) return null;
  try { return { context: JSON.parse(json) as TContext, buyerText: rest.slice(tail.length) }; }
  catch { return null; }
}
