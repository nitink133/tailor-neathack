import type { BrowserSession, DemoSummary } from '../../tailor/demo-contract.ts';

export interface EntryStarter { id: string; capabilityId: string; title: string; prompt: string }
export interface EntrySuggestion extends EntryStarter { lead: string; text: string }
interface StarterProjection {
  starters: EntryStarter[];
  capabilities: { id: string; support: string }[];
}

// Each alternate stays within its server-projected starter's fictional workflow.
// Unknown or unavailable starters never acquire locally invented capabilities.
const phrasing: Record<string, { lead: string; text: string; alternate: string; alternateLead: string; alternateText: string }> = {
  'retrieval-quality': {
    lead: 'Show', text: 'me an ungrounded answer',
    alternateLead: 'Check', alternateText: 'what the source supports',
    alternate: 'Create a fictional documentation question-answering workflow with a relevant retrieval and an answer that claims an unsupported feature absent from the source.',
  },
  'extraction-quality': {
    lead: 'Find', text: 'missing invoice fields',
    alternateLead: 'Show', alternateText: 'an omitted due date',
    alternate: 'Show a fictional invoice extraction workflow where the JSON is valid but the extracted output is missing the due date.',
  },
  'support-quality': {
    lead: 'Review', text: 'a support answer',
    alternateLead: 'Check', alternateText: 'if support resolved it',
    alternate: 'Create a fictional customer support workflow where a successful lookup is followed by a polite answer that does not resolve the customer request.',
  },
};

export function entrySuggestions(projection?: StarterProjection): EntrySuggestion[] {
  if (!projection) return [];
  const executable = new Set(projection.capabilities.filter(c => c.support === 'executable').map(c => c.id));
  const starters = projection.starters.filter(s => executable.has(s.capabilityId) && s.prompt.trim()).slice(0, 3);
  const primary = starters.map(s => {
    const words = s.capabilityId === 'synthetic-quality-workflows' ? phrasing[s.id] : undefined;
    // Paired contractions can look like quoted material to the offline policy.
    // Expand these two phrases without changing the projected request's meaning.
    const prompt = words ? s.prompt.replace(/\bI[’']m\b/g, 'I am').replace(/\bdoesn[’']t\b/g, 'does not') : s.prompt;
    return { ...s, prompt, lead: words?.lead ?? '', text: words?.text ?? (s.title || s.prompt) };
  });
  const alternate = starters.flatMap(s => {
    const words = s.capabilityId === 'synthetic-quality-workflows' ? phrasing[s.id] : undefined;
    return words ? [{ ...s, id: `${s.id}-alternate`, prompt: words.alternate, lead: words.alternateLead, text: words.alternateText }] : [];
  });
  return [...primary, ...alternate];
}

export function suggestionBatch(suggestions: EntrySuggestion[], batch: number): EntrySuggestion[] {
  const batches = Math.ceil(suggestions.length / 3);
  if (!batches) return [];
  const start = ((batch % batches) + batches) % batches * 3;
  return suggestions.slice(start, start + 3);
}

export function entrySavedState(session?: BrowserSession): { demos: DemoSummary[]; activeDemo?: DemoSummary } {
  const demos = session?.state === 'active' && Array.isArray(session.demos)
    ? session.demos.filter(d => d && typeof d.id === 'string' && d.id.length > 0 && typeof d.label === 'string' && Number.isInteger(d.version) && d.version > 0)
    : [];
  return { demos, activeDemo: demos.find(d => d.id === session?.activeDemoId) };
}
