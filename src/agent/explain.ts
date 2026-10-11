// Deterministic, evidence-grounded explanations. Every number, name and ID here comes from a saved/read-back
// trace, never from the model. The model's narrative (if any) is appended AFTER the evidence.

import type { Evidence, Span, Trace } from '../contracts.ts';
import type { ReadbackEvidence } from '../agent-contract.ts';
import { clip } from './context.ts';

const MAX_NARRATIVE_CHARS = 700;

/** Model text is data: flatten, strip code fences/backticks, bound the length. */
export function cleanNarrative(text: string | undefined): string {
  if (!text) return '';
  return clip(text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, ''), MAX_NARRATIVE_CHARS);
}

const ms = (n: number) => (Number.isInteger(n) ? `${n} ms` : `${Math.round(n * 100) / 100} ms`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const rootOf = (trace: Trace): Span | undefined => trace.spans.find(s => s.parentId === null);

export function errorSpans(trace: Trace): Span[] { return trace.spans.filter(s => s.status === 'ERROR'); }

/** The error spans' IDs, falling back to the root span so evidence never cites nothing. */
export function citedSpanIds(trace: Trace): string[] {
  const errors = errorSpans(trace).map(s => s.id);
  if (errors.length) return errors;
  const root = rootOf(trace);
  return root ? [root.id] : [];
}

/** Full walk-through built from the ACTUAL spans: names, statuses, timing offsets, error text, outcome. */
export function describeTrace(trace: Trace): string {
  const root = rootOf(trace);
  const ordered = [...trace.spans].sort((a, b) => a.startMs - b.startMs);
  const errors = errorSpans(trace);
  const lines: string[] = [];
  lines.push(`“${trace.label}” took ${ms(root?.durationMs ?? 0)} end to end across ${plural(trace.spans.length, 'step')} and finished as ${trace.outcome} (${trace.outcomeKind}).`);
  lines.push('Step by step:');
  ordered.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.name} — ${s.kind}, ${s.status}, starts +${ms(s.startMs)}, takes ${ms(s.durationMs)}`);
  });
  if (errors.length === 0) lines.push('No step failed in this run.');
  else {
    lines.push(`${plural(errors.length, 'step')} failed:`);
    for (const s of errors) lines.push(`• ${s.name} at +${ms(s.startMs)} after ${ms(s.durationMs)}: ${clip(s.error ?? 'no error text', 200)}`);
    const flagged = errors.filter(s => s.detection);
    if (flagged.length) lines.push(`Flagged as “Execution Failed”: ${flagged.map(s => s.name).join(', ')}.`);
  }
  return lines.join('\n');
}

export interface CommitExplanation { text: string; evidence: Evidence }

/**
 * Evidence sentence for a committed publication, from the independent read-back (and the trace read through the tool).
 * `trace` may be null when the follow-up read failed; the sentence then says so instead of guessing names.
 */
export function describeCommit(readback: ReadbackEvidence, trace: Trace | null, narrative: string): CommitExplanation {
  const entry = readback.traces.find(t => t.key === readback.activeScenario) ?? readback.traces.find(t => t.id === readback.traceIds[0]) ?? readback.traces[0];
  if (!entry) {
    return { text: `Saved and verified as version ${readback.version}.${narrative ? ` ${narrative}` : ''}`, evidence: { version: readback.version, traceIds: [...readback.traceIds], spanIds: [...readback.spanIds] } };
  }
  const failed = trace ? trace.spans.filter(s => entry.errorSpanIds.includes(s.id)) : [];
  let failure: string;
  if (entry.errorSpanIds.length === 0) failure = 'No step failed.';
  else if (failed.length) failure = `${plural(failed.length, 'step')} failed: ${failed.map(s => `${s.name} (${clip(s.error ?? 'error', 160)})`).join('; ')}.`;
  else failure = `${plural(entry.errorSpanIds.length, 'step')} ended in an error (names could not be read back just now).`;
  const text = `Saved and verified as version ${readback.version}. “${entry.label}” runs ${ms(entry.rootDurationMs)} end to end across ${plural(entry.spanCount, 'step')} and ends as ${entry.outcome}. ${failure}${narrative ? ` ${narrative}` : ''}`;
  const spanIds = entry.errorSpanIds.length ? [...entry.errorSpanIds] : trace ? citedSpanIds(trace) : [];
  const traceIds = [entry.id, ...readback.traceIds.filter(id => id !== entry.id)];
  return { text, evidence: { version: readback.version, traceIds, spanIds } };
}
