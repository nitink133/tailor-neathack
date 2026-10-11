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

/** Sentence split that keeps decimals ("2.86 s") and identifiers intact. */
export function splitSentences(text: string): string[] {
  return (text.replace(/\s+/g, ' ').trim().match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)/g) ?? []).map(s => s.trim()).filter(Boolean);
}

const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|INR|CAD|AUD)\b/i;
const PRICE_UNIT = /\d[\d,.]*\s*(?:dollars?|euros?|pounds?|bucks|usd|eur|gbp)\b|\bper\s+(?:month|year|seat|user|mo|yr|team|project)\b|\/\s*(?:mo|month|yr|year|seat|user)\b|\ba\s+(?:month|year)\b|\b(?:monthly|annually|yearly)\b|\bpricing\s+tiers?\b|\b(?:costs?|priced|charges?|charged|billed)\b[^.]{0,40}\d/i;
/** A sentence that states a price, a billing amount or a pricing tier. Product copy may say "pricing" with no number. */
export function hasPricingClaim(sentence: string): boolean {
  return CURRENCY.test(sentence) || PRICE_UNIT.test(sentence);
}

const IDENTIFIER = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+/g;
const PLAIN_COMPOUNDS = new Set(['end-to-end', 'follow-up', 'built-in', 'read-only', 'explain-only', 'mock-backed', 'real-time', 'one-off', 'step-by-step', 'fail-safe', 'non-blocking', 'time-out', 'back-off', 'well-known', 'so-called', 'on-call', 'drop-in', 'trade-off', 'e-commerce', 'check-in', 'sign-in', 'log-in', 'run-time', 'high-level', 'low-level']);
const MEASURE = /(\d[\d,]*(?:\.(\d+))?)\s*(ms|milliseconds?|seconds?|secs?|s|%)(?![A-Za-z])/gi;
const MUTATION = /\b(?:sav(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|remov(?:e|ed|es|ing)|updat(?:e|ed|es|ing)|chang(?:e|ed|es|ing)|modif(?:y|ied|ies|ying)|wr(?:ote|itten|ite|ites)|publish(?:ed|es)?|push(?:ed|es)?|creat(?:e|ed|es|ing)|dropp?(?:ed|s)?|wip(?:e|ed|es)|renam(?:e|ed|es)|overwr(?:ote|itten|ite|ites)|edit(?:ed|s)?)\b/i;
const REAL_TARGET = /\b(?:real|production|actual)\b|\bneatlogs\s+(?:project|account|workspace|environment|data)\b|\b(?:your|my)\s+(?:neatlogs\s+)?(?:project|account|workspace)\b|\blive\b[^.]{0,40}\b(?:neatlogs|project|account|workspace|environment|traces?)\b/i;

function allowedIdentifiers(trace: Trace | null, readback: ReadbackEvidence | null): Set<string> {
  const ok = new Set<string>();
  const add = (v: string | undefined | null) => { if (v) ok.add(v.toLowerCase()); };
  if (trace) {
    add(trace.id); add(trace.scenario); add(trace.label); add(trace.name); add(trace.outcome);
    trace.tags.forEach(add);
    trace.spans.forEach(s => { add(s.id); add(s.name); });
  }
  if (readback) {
    readback.traceIds.forEach(add); readback.spanIds.forEach(add); add(readback.activeScenario);
    for (const t of readback.traces) { add(t.id); add(t.key); add(t.label); add(t.outcome); t.errorSpanIds.forEach(add); }
  }
  return ok;
}

function allowedMeasures(trace: Trace | null, readback: ReadbackEvidence | null): { ms: number[]; percents: number[] } {
  const msValues = new Set<number>();
  const percents: number[] = [];
  const addFromText = (text: string | null) => {
    if (!text) return;
    for (const m of text.matchAll(MEASURE)) {
      const unit = m[3]!.toLowerCase();
      if (unit === '%') continue;
      const v = Number(m[1]!.replace(/,/g, ''));
      msValues.add(unit.startsWith('ms') || unit.startsWith('milli') ? v : v * 1000);
    }
  };
  if (trace) {
    const root = rootOf(trace);
    for (const s of trace.spans) {
      msValues.add(s.startMs); msValues.add(s.durationMs); msValues.add(s.startMs + s.durationMs);
      addFromText(s.error);
      if (root && root.durationMs > 0) percents.push(s.durationMs / root.durationMs * 100);
    }
  }
  readback?.traces.forEach(t => msValues.add(t.rootDurationMs));
  return { ms: [...msValues], percents };
}

function measuresMatch(sentence: string, allowed: { ms: number[]; percents: number[] }): boolean {
  for (const m of sentence.matchAll(MEASURE)) {
    const unit = m[3]!.toLowerCase();
    const decimals = m[2]?.length ?? 0;
    const value = Number(m[1]!.replace(/,/g, ''));
    if (unit === '%') {
      const tol = 0.5 * 10 ** -decimals;
      if (!allowed.percents.some(p => Math.abs(p - value) <= tol + 0.001)) return false;
      continue;
    }
    const inMs = unit.startsWith('ms') || unit.startsWith('milli') ? value : value * 1000;
    const tol = unit.startsWith('ms') || unit.startsWith('milli') ? 0.5 : 0.5 * 10 ** -decimals * 1000;
    if (!allowed.ms.some(a => Math.abs(a - inMs) <= tol + 0.001)) return false;
  }
  return true;
}

/**
 * Keep only the model's sentences that the read-back evidence can back. Dropped: identifiers that are not span/trace
 * names or IDs in the trace, durations/percentages that match no span, claims about changing a real/production/live
 * Neatlogs project, and any price. The evidence sentence (describeCommit/describeTrace) stays first and authoritative.
 */
export function groundNarrative(text: string | undefined, trace: Trace | null, readback: ReadbackEvidence | null): string {
  const cleaned = cleanNarrative(text);
  if (!cleaned) return '';
  const ids = allowedIdentifiers(trace, readback);
  const measures = allowedMeasures(trace, readback);
  const kept: string[] = [];
  for (const sentence of splitSentences(cleaned)) {
    if (hasPricingClaim(sentence)) continue;
    if (MUTATION.test(sentence) && REAL_TARGET.test(sentence)) continue;
    const unknownId = (sentence.match(IDENTIFIER) ?? []).some(tok => {
      const t = tok.toLowerCase();
      if (!/[a-z]/.test(t) || PLAIN_COMPOUNDS.has(t)) return false;
      // Known if it is a trace/span name or ID, or a whole piece of one (e.g. "travel-booking" inside a span name).
      return ![...ids].some(known => known === t || known.includes(t));
    });
    if (unknownId) continue;
    if (!measuresMatch(sentence, measures)) continue;
    kept.push(sentence);
  }
  return kept.join(' ');
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
