// Deterministic, evidence-grounded explanations. Every number, name and ID here comes from a saved/read-back
// trace, never from the model. The model's narrative (if any) is appended AFTER the evidence.

import type { Evidence, Json, Span, Trace } from './contracts.ts';
import type { ReadbackEvidence } from './agent-contract.ts';
import { clip, cleanNarrative } from '../../tailor/text.ts';
import { buildCorpus, hasPricingClaim, isUngroundedClaim, shadowOf, splitSentences } from './claims.ts';

export { cleanNarrative, splitSentences, hasPricingClaim };

const IDENTIFIER = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+/g;
const PLAIN_COMPOUNDS = new Set(['end-to-end', 'follow-up', 'built-in', 'read-only', 'explain-only', 'mock-backed', 'real-time', 'one-off', 'step-by-step', 'fail-safe', 'non-blocking', 'time-out', 'back-off', 'well-known', 'so-called', 'on-call', 'drop-in', 'trade-off', 'e-commerce', 'check-in', 'sign-in', 'log-in', 'run-time', 'high-level', 'low-level']);
// Every measure the narrative may state: durations, percentages and counts. Each one must match the evidence. Sentences
// are checked in their shadow form (NFKC, number words as digits), so "three times", "twice" and "３ times" land here too.
const MEASURE = /(\d[\d,]*(?:\.(\d+))?)\s*(ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|%|percent|per\s*cent|times?|attempts?|retries|retry|steps?|spans?|errors?|failures?|traces?)(?![A-Za-z])/gi;
/**
 * Trace-evidence statement: "It/the trace shows|marks|records|detects|flags <span name> …". When the named span is in
 * the saved trace, the clause describes evidence rather than a product capability, so the capability rule does not
 * apply to it (numbers, names and every other rule still do). Modal forms ("It can detect …") stay capability claims.
 */
const EVIDENCE_STATEMENT = /^\s*(?:it|the\s+(?:saved\s+)?(?:trace|run)|this\s+(?:trace|run))\s+(?:shows|marks|records|detects|flags)\s+([A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+)\b/i;
const PLAIN_NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const CAMEL_CASE = /\b(?:[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[a-z]+(?:[A-Z][a-z0-9]+)+)\b/g;
const QUOTED = /[“"]([^”"]{1,80})[”"]|(?<![A-Za-z0-9])[‘']([^’']{1,60})[’'](?![A-Za-z0-9])/g;
const MUTATION = /\b(?:sav(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|remov(?:e|ed|es|ing)|updat(?:e|ed|es|ing)|chang(?:e|ed|es|ing)|modif(?:y|ied|ies|ying)|wr(?:ote|itten|ite|ites)|publish(?:ed|es)?|push(?:ed|es)?|creat(?:e|ed|es|ing)|dropp?(?:ed|s)?|wip(?:e|ed|es)|renam(?:e|ed|es)|overwr(?:ote|itten|ite|ites)|edit(?:ed|s)?)\b/i;
const REAL_TARGET = /\b(?:real|production|actual)\b|\bneatlogs\s+(?:project|account|workspace|environment|data)\b|\b(?:your|my)\s+(?:neatlogs\s+)?(?:project|account|workspace)\b|\blive\b[^.]{0,40}\b(?:neatlogs|project|account|workspace|environment|traces?)\b/i;

const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const numbersIn = (s: string | null | undefined): number[] => (s ?? '').match(PLAIN_NUMBER)?.map(n => Number(n.replace(/,/g, ''))).filter(n => Number.isFinite(n)) ?? [];

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

/** Labels, names, scenario keys, tags and outcomes of the saved evidence (words only; no payloads). */
function domainText(trace: Trace | null, readback: ReadbackEvidence | null): string {
  const parts: string[] = [];
  if (trace) parts.push(trace.label, trace.name, trace.scenario, trace.outcome, ...trace.tags, ...trace.spans.map(s => s.name));
  if (readback) for (const t of readback.traces) parts.push(t.label, t.key, t.outcome);
  return parts.join(' ');
}

interface Allowed {
  /** Durations in ms (span starts, durations, ends, root durations, and times quoted in span error text). */
  ms: number[];
  percents: number[];
  /** Counts the evidence supports: span/error/trace counts. */
  counts: Set<number>;
  /** "N times / attempts / retries": only the number of retry/attempt-named spans (or a number in a name/error) counts. */
  attempts: Set<number>;
  /** "retried N times / N retries": attempt-named spans minus the first try (a 2-attempt trace retried once). */
  retries: Set<number>;
  /** Plain numbers: versions, counts, numbers in names/labels/error text, HTTP status codes in error text/output. */
  plain: Set<number>;
  /** Step/span count, for "step 3" references. */
  stepMax: number;
  /** Lowercase alphanumeric-only text of every name/label/error/outcome, for CamelCase and quoted-name checks. */
  corpus: string;
}

const TIME_MS: Record<string, number> = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 };
const COUNT_UNIT = /^(?:steps?|spans?|errors?|failures?|traces?)$/;
const ATTEMPT_UNIT = /^(?:times?|attempts?|retries|retry)$/;
const PERCENT_UNIT = /^(?:%|percent|per\s*cent)$/;
const unitKey = (u: string): string => u.toLowerCase().replace(/\s+/g, '');

function buildAllowed(trace: Trace | null, readback: ReadbackEvidence | null): Allowed {
  const ms = new Set<number>();
  const percents: number[] = [];
  const counts = new Set<number>();
  const attempts = new Set<number>();
  const retries = new Set<number>();
  const plain = new Set<number>();
  const text: string[] = ['execution failed'];
  let stepMax = 0;
  const addTimes = (t: string | null) => {
    if (!t) return;
    for (const m of t.matchAll(MEASURE)) {
      const factor = TIME_MS[unitKey(m[3]!)];
      if (factor) ms.add(Number(m[1]!.replace(/,/g, '')) * factor);
    }
  };
  if (trace) {
    const root = rootOf(trace);
    stepMax = Math.max(stepMax, trace.spans.length);
    counts.add(trace.spans.length); counts.add(errorSpans(trace).length); counts.add(1); // one trace
    const attemptSpans = trace.spans.filter(s => /attempt/i.test(s.name)).length;
    attempts.add(attemptSpans || trace.spans.filter(s => /retry/i.test(s.name)).length);
    if (attemptSpans >= 2) retries.add(attemptSpans - 1);
    text.push(trace.id, trace.scenario, trace.label, trace.name, trace.outcome, ...trace.tags);
    for (const t of [trace.id, trace.label, trace.name, trace.outcome, ...trace.tags]) numbersIn(t).forEach(n => plain.add(n));
    for (const s of trace.spans) {
      ms.add(s.startMs); ms.add(s.durationMs); ms.add(s.startMs + s.durationMs);
      text.push(s.id, s.name, s.error ?? '');
      addTimes(s.error);
      numbersIn(s.error).forEach(n => plain.add(n));
      numbersIn(s.name).forEach(n => { plain.add(n); attempts.add(n); });
      for (const blob of [JSON.stringify(s.output ?? null), JSON.stringify(s.input ?? null)]) {
        for (const m of blob.matchAll(/(?:status|code|http)\D{0,12}([1-5]\d{2})\b/gi)) plain.add(Number(m[1]));
      }
      if (root && root.durationMs > 0) percents.push(s.durationMs / root.durationMs * 100);
    }
  }
  if (readback) {
    plain.add(readback.version);
    counts.add(readback.traceIds.length);
    for (const t of readback.traces) {
      ms.add(t.rootDurationMs); counts.add(t.spanCount); counts.add(t.errorSpanIds.length);
      stepMax = Math.max(stepMax, t.spanCount);
      text.push(t.id, t.label, t.outcome, t.key);
    }
  }
  counts.delete(0); attempts.delete(0); retries.delete(0); // a zero count is never ground for a claim
  for (const c of counts) plain.add(c);
  for (const c of attempts) plain.add(c);
  return { ms: [...ms], percents, counts, attempts, retries, plain, stepMax, corpus: flat(text.join(' ')) };
}

/** Does every measure (time, percent, count) and every other number in the sentence match the evidence? */
function numbersMatch(sentence: string, known: (token: string) => boolean, allowed: Allowed): boolean {
  // Known identifiers (span names/IDs) carry digits of their own; remove them before reading numbers.
  let rest = sentence.replace(IDENTIFIER, tok => (known(tok) ? ' ' : tok));
  for (const m of rest.matchAll(MEASURE)) {
    const retry = /^retr/i.test(m[3]!) || /\bretr(?:ied|ies|y|ying)\b[^.;]*$/i.test(rest.slice(0, m.index));
    if (!measureOk(Number(m[1]!.replace(/,/g, '')), m[2]?.length ?? 0, unitKey(m[3]!), allowed, retry)) return false;
  }
  rest = rest.replace(MEASURE, ' ');
  for (const m of rest.matchAll(PLAIN_NUMBER)) {
    const value = Number(m[0].replace(/,/g, ''));
    if (allowed.plain.has(value)) continue;
    // "step 3" / "span 2" / "#2" refer to a position in the walk-through, which exists up to the span count.
    const before = rest.slice(0, m.index).replace(/\s+$/, '');
    if (/(?:step|span|#)$/i.test(before) && Number.isInteger(value) && value >= 1 && value <= allowed.stepMax) continue;
    return false;
  }
  return true;
}

function measureOk(value: number, decimals: number, unit: string, allowed: Allowed, retry = false): boolean {
  if (PERCENT_UNIT.test(unit)) {
    const tol = 0.5 * 10 ** -decimals;
    return allowed.percents.some(p => Math.abs(p - value) <= tol + 0.001);
  }
  if (COUNT_UNIT.test(unit)) return allowed.counts.has(value);
  if (ATTEMPT_UNIT.test(unit)) return (retry ? allowed.retries : allowed.attempts).has(value);
  const factor = TIME_MS[unit];
  if (factor === undefined) return false;
  const inMs = value * factor;
  const tol = factor === 1 ? 0.5 : 0.5 * 10 ** -decimals * factor;
  return allowed.ms.some(a => Math.abs(a - inMs) <= tol + 0.001);
}

/** CamelCase tokens and quoted names must be present in the evidence (span names, trace labels, error text, outcomes). */
function namesGrounded(sentence: string, allowed: Allowed): boolean {
  for (const m of sentence.matchAll(CAMEL_CASE)) if (!allowed.corpus.includes(flat(m[0]))) return false;
  for (const m of sentence.matchAll(QUOTED)) {
    const quoted = flat(m[1] ?? m[2] ?? '');
    if (quoted && !allowed.corpus.includes(quoted)) return false;
  }
  return true;
}

/** Bounded fixture checks over inspected payloads; labels and an all-OK status alone never establish quality. */
export function qualityDefectNarrative(trace: { output: Json; spans: readonly Pick<Span, 'kind' | 'status' | 'error' | 'output'>[] }): string {
  const record = (value: Json): Record<string, Json> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!trace.spans.length || trace.spans.some(span => span.status !== 'OK' || span.error !== null)) return '';
  const output = record(trace.output);
  if (!output) return '';
  const sources = trace.spans.map(span => ({ kind: span.kind, value: record(span.output) })).filter(source => source.value !== null);
  if ((output.dueDate === undefined || output.dueDate === null || output.dueDate === '')
    && sources.some(source => source.kind === 'LLM' && typeof source.value!.dueDate === 'string' && source.value!.dueDate.trim())) {
    return 'The output omits the due date present in the source, despite completing without an execution error.';
  }
  if (output.resolved === false && output.answer === 'Thanks for your patience. We appreciate you!'
    && sources.some(source => source.kind === 'TOOL' && typeof source.value!.nextStep === 'string' && source.value!.nextStep.trim()
      && !(output.answer as string).toLowerCase().includes((source.value!.nextStep as string).toLowerCase()))) {
    return 'The output records the request as unresolved and omits the next step supplied by the lookup, despite completing without an execution error.';
  }
  if (output.answer === 'Offline sync is supported automatically.'
    && sources.some(source => source.kind === 'RETRIEVAL' && source.value!.text === 'The Widget SDK sends updates while connected. Offline behavior is not documented.')) {
    return 'The answer claims offline sync is supported, but the retrieved source says offline behavior is not documented.';
  }
  // These are recorded verdict fields in synthetic spans, not a new semantic judgment or an executed hosted eval.
  const checks = sources.filter(source => source.kind === 'GUARDRAIL').map(source => source.value!);
  if (output.grounded === false && checks.some(check => check.claimFoundInSources === false
    && Number.isSafeInteger(check.unsupportedClaims) && Number(check.unsupportedClaims) > 0)) {
    return 'In this synthetic trace, the saved source-grounding check reports an unsupported claim despite its OK execution status; compare the retrieved passages with the final answer rather than treating green execution as proof of correctness.';
  }
  if ((output.dueDate === undefined || output.dueDate === null || output.dueDate === '')
    && sources.some(source => source.kind === 'TOOL' && typeof source.value!.text === 'string'
      && /\b(?:payment due|due date)\s*:\s*\d{4}-\d{2}-\d{2}\b/i.test(source.value!.text))) {
    return 'The saved document text records a payment-due date while the final output omits dueDate; an error-free run and a field-presence check do not establish that an extracted value agrees with the source.';
  }
  if (output.nextStepIncluded === false && checks.some(check => check.passed === false
    && Array.isArray(check.missing) && check.missing.includes('repair booking next step'))) {
    return 'In this synthetic trace, the saved completeness check reports a missing repair booking next step despite its OK execution status; compare the recorded missing requirement with the final answer.';
  }
  return '';
}

/** Model prose is admitted only as a supported fact form; other prose falls back to code-owned readback wording. */
function semanticsGrounded(sentence: string, trace: Trace | null, readback: ReadbackEvidence | null): boolean {
  const text = sentence.trim();
  const entries = readback?.traces ?? [];
  const entry = trace ?? entries.find(t => t.key === readback?.activeScenario) ?? entries[0];
  if (!entry) return false;
  const spans = trace?.spans ?? [];
  const root = spans.find(s => s.parentId === null);
  const errors = spans.filter(s => s.status === 'ERROR');
  const count = trace ? spans.length : (entry as ReadbackEvidence['traces'][number]).spanCount;
  const errorCount = trace ? errors.length : (entry as ReadbackEvidence['traces'][number]).errorSpanIds.length;
  const duration = trace ? root?.durationMs : (entry as ReadbackEvidence['traces'][number]).rootDurationMs;
  const time = (n: string, unit: string) => Number(n.replace(/,/g, '')) * (/^(?:s|sec|seconds?)$/i.test(unit) ? 1000 : 1);
  const same = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) <= 0.5;
  const target = (name: string) => {
    const key = name.replace(/^(?:the|a)\s+/i, '').replace(/\s+(?:step|span)$/, '').trim().toLowerCase();
    if (key === 'root') return root;
    if (key === 'retry' || key === 'second attempt' || key === 'last attempt') return spans.filter(s => /retry|attempt[_ -]?(?:[2-9]|\d{2,})\b/i.test(s.name)).at(-1);
    return spans.find(s => s.name.toLowerCase() === key || s.id.toLowerCase() === key);
  };
  // An explicit quotation of recorded error text is a fact about the saved error, not an inferred cause.
  let m = /^(?:the )?error says (.+?)[.!]?$/i.exec(text);
  if (m) return errors.some(s => flat(s.error ?? '').includes(flat(m![1]!)));
  m = /^the gateway returned HTTP (\d+)\.$/i.exec(text);
  if (m) return errors.some(s => flat(s.error ?? '').includes(flat(`gateway returned HTTP ${m![1]}`)));
  if (flat(text) === flat(safeNarrative(trace, readback))) return true;
  m = /^(?:the )?(?:run|trace) has ([\d,]+) (?:steps|spans) and ([\d,]+) failed\.$/i.exec(text);
  if (m) return Number(m[1]!.replace(/,/g, '')) === count && Number(m[2]!.replace(/,/g, '')) === errorCount;
  m = /^(?:the )?(?:run|trace) has ([\d,]+) (?:steps|spans)\.$/i.exec(text);
  if (m) return Number(m[1]!.replace(/,/g, '')) === count;
  m = /^(?:the )?(.+?) was tried (\d+) times\.$/i.exec(text);
  if (m) { const stem = m[1]!.trim().toLowerCase().replace(/\s+/g, '_'); const attempts = spans.filter(s => s.name.toLowerCase().startsWith(stem + '_attempt_')); return attempts.length > 0 && attempts.length === Number(m[2]); }
  m = /^step (\d+) is where it breaks\.$/i.exec(text);
  if (m) return spans[Number(m[1]) - 1]?.status === 'ERROR';
  m = /^(?:this is saved as|this was|saved as) version (\d+)\.$/i.exec(text);
  if (m) return Number(m[1]) === readback?.version;
  m = /^the run is end-to-end ([\d,.]+) (ms|milliseconds?|s|sec|seconds?) long\.$/i.exec(text);
  if (m) return same(duration, time(m[1]!, m[2]!));
  m = /^timing was ([\d,.]+) (ms|milliseconds?|s|sec|seconds?) overall\.$/i.exec(text);
  if (m) return same(duration, time(m[1]!, m[2]!));
  m = /^(?:the )?(?:run|trace|root) took ([\d,.]+) (ms|milliseconds?|s|sec|seconds?)\.$/i.exec(text);
  if (m) return same(duration, time(m[1]!, m[2]!));
  m = /^it took ([\d,.]+) (ms|milliseconds?|s|sec|seconds?) to fail\.$/i.exec(text);
  if (m) return errors.some(e => same(e.durationMs, time(m![1]!, m![2]!)));
  m = /^(.+?) is where it broke\.$/i.exec(text);
  if (m) return target(m[1]!)?.status === 'ERROR';
  m = /^(.+?) was ([\d.]+)% of the run\.$/i.exec(text);
  if (m) { const t = target(m[1]!); return !!t && !!duration && Math.abs(t.durationMs / duration * 100 - Number(m[2])) <= 0.5; }
  m = /^(?:the )?(.+?) (failed|succeeded|recovered|timed out|is marked ERROR|is marked OK)(?: after ([\d,.]+) (ms|milliseconds?|s|sec|seconds?))?\.$/i.exec(text);
  if (m) { const t = target(m[1]!); return !!t && t.status === (/failed|ERROR|timed out/i.test(m[2]!) ? 'ERROR' : 'OK') && (!/timed out/i.test(m[2]!) || /timed? out|timeout/i.test(t.error ?? '')) && (!m[3] || same(t.durationMs, time(m[3], m[4]!))); }
  m = /^the [“"'](.+?)[”"'] run ended as (.+?)\.$/i.exec(text);
  if (m) return flat(m[1]!) === flat(entry.label) && flat(m[2]!) === flat(entry.outcome);
  return false;
}

/**
 * Keep only the model's sentences that the read-back evidence can back. Dropped: prices, plan/tier wording,
 * capability assertions about the product, retention/limit numbers; identifiers, CamelCase and quoted names that are not
 * in the trace; any number (duration, percentage, count, HTTP code) that matches no evidence; and claims about changing a
 * real/production/live Neatlogs project. The evidence sentence (describeCommit/describeTrace) stays first and
 * authoritative and is never filtered.
 */
export function groundNarrative(text: string | undefined, trace: Trace | null, readback: ReadbackEvidence | null): string {
  const cleaned = cleanNarrative(text);
  if (!cleaned) return '';
  const ids = allowedIdentifiers(trace, readback);
  const allowed = buildAllowed(trace, readback);
  const isKnownIdentifier = (tok: string): boolean => {
    const t = tok.toLowerCase();
    if (!/[a-z]/.test(t) || PLAIN_COMPOUNDS.has(t)) return true;
    // Known if it is a trace/span name or ID, or a whole piece of one (e.g. "travel-booking" inside a span name).
    return [...ids].some(known => known === t || known.includes(t));
  };
  // Saved labels/names/tags: a bare plan-like word they use ("the enterprise checkout") is a domain word here.
  const domain = buildCorpus(domainText(trace, readback));
  const spanNames = new Set(trace?.spans.map(s => s.name.toLowerCase()) ?? []);
  const exemptClause = (clause: string) => { const m = EVIDENCE_STATEMENT.exec(clause); return !!m && spanNames.has(m[1]!.toLowerCase()); };
  const kept: string[] = [];
  const quality = trace ? qualityDefectNarrative(trace) : '';
  for (const sentence of splitSentences(cleaned)) {
    const shadow = shadowOf(sentence);
    // Only the exact code-owned defect description can bypass generic product-capability filtering.
    if (quality && flat(shadow) === flat(shadowOf(quality))) { kept.push(quality); continue; }
    if (isUngroundedClaim(shadow, { corpus: domain, exemptClause })) continue;
    if (MUTATION.test(shadow) && REAL_TARGET.test(shadow)) continue;
    if ((shadow.match(IDENTIFIER) ?? []).some(tok => !isKnownIdentifier(tok))) continue;
    if (!namesGrounded(shadow, allowed)) continue;
    if (!numbersMatch(shadow, isKnownIdentifier, allowed)) continue;
    if (!semanticsGrounded(shadow, trace, readback)) continue;
    kept.push(sentence);
  }
  return kept.join(' ');
}

/**
 * Deterministic wording built only from the read-back evidence. Used when the model supplied narrative text and every
 * sentence was dropped, so the reply still says something true about where to look instead of going silent.
 */
export function safeNarrative(trace: Trace | null, readback: ReadbackEvidence | null): string {
  if (trace) {
    const quality = qualityDefectNarrative(trace);
    if (quality) return quality;
    const errors = errorSpans(trace);
    if (errors.length === 0) return 'No step in the saved trace is marked ERROR.';
    const names = errors.map(s => s.name).join(', ');
    return `In the saved trace, ${names} ${errors.length === 1 ? 'is' : 'are'} marked ERROR.`;
  }
  if (readback) {
    const entry = readback.traces.find(t => t.key === readback.activeScenario) ?? readback.traces[0];
    if (!entry) return '';
    return entry.errorSpanIds.length === 0 ? 'No step in the saved trace is marked ERROR.' : `${plural(entry.errorSpanIds.length, 'step')} in the saved trace ${entry.errorSpanIds.length === 1 ? 'is' : 'are'} marked ERROR.`;
  }
  return '';
}

/** groundNarrative, but when the model's text was non-empty and fully dropped, fall back to {@link safeNarrative}. */
export function groundNarrativeOrFallback(text: string | undefined, trace: Trace | null, readback: ReadbackEvidence | null): string {
  const grounded = groundNarrative(text, trace, readback);
  if (grounded) return grounded;
  return cleanNarrative(text) ? safeNarrative(trace, readback) : '';
}

const ms = (n: number) => (Number.isInteger(n) ? `${n} ms` : `${Math.round(n * 100) / 100} ms`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const rootOf = (trace: Trace): Span | undefined => trace.spans.find(s => s.parentId === null);

export function errorSpans(trace: Trace): Span[] { return trace.spans.filter(s => s.status === 'ERROR'); }

/** Error evidence, or the observed source/check payloads behind an all-green quality observation. */
export function citedSpanIds(trace: Trace): string[] {
  const errors = errorSpans(trace).map(s => s.id);
  if (errors.length) return errors;
  const root = rootOf(trace);
  if (qualityDefectNarrative(trace)) {
    const observations = trace.spans.filter(span => {
      if (!span.output || typeof span.output !== 'object' || Array.isArray(span.output)) return false;
      const value = span.output;
      return span.kind === 'RETRIEVAL'
        || span.kind === 'LLM' && typeof value.dueDate === 'string' && !!value.dueDate.trim()
        || span.kind === 'TOOL' && (typeof value.nextStep === 'string' || typeof value.text === 'string' && /\b(?:payment due|due date)\s*:\s*\d{4}-\d{2}-\d{2}\b/i.test(value.text) || value.repairBookingAvailable === true)
        || span.kind === 'GUARDRAIL' && (value.claimFoundInSources === false || value.passed === false && Array.isArray(value.missing));
    });
    return [...new Set([...(root ? [root.id] : []), ...observations.map(span => span.id)])];
  }
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
  if (errors.length === 0) lines.push(qualityDefectNarrative(trace) || 'No step failed in this run.');
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
    return { text: `Saved and verified as version ${readback.version}.${narrative ? `\n\n1. Read the saved evidence\n${narrative}` : ''}`, evidence: { version: readback.version, traceIds: [...readback.traceIds], spanIds: [...readback.spanIds] } };
  }
  const failed = trace ? trace.spans.filter(s => entry.errorSpanIds.includes(s.id)) : [];
  let failure: string;
  if (entry.errorSpanIds.length === 0) failure = 'No step failed.';
  else if (failed.length) failure = `${plural(failed.length, 'step')} failed: ${failed.map(s => `${s.name} (${clip(s.error ?? 'error', 160)})`).join('; ')}.`;
  else failure = `${plural(entry.errorSpanIds.length, 'step')} ended in an error (names could not be read back just now).`;
  const text = [
    `Saved and verified as version ${readback.version}.`,
    `1. Review the run\n“${entry.label}” runs ${ms(entry.rootDurationMs)} end to end across ${plural(entry.spanCount, 'step')} and ends as ${entry.outcome}.`,
    `2. Inspect failed steps\n${failure}`,
    ...(narrative ? [`3. Read the saved evidence\n${narrative}`] : []),
  ].join('\n\n');
  const spanIds = entry.errorSpanIds.length ? [...entry.errorSpanIds] : trace ? citedSpanIds(trace) : [];
  const traceIds = [entry.id, ...readback.traceIds.filter(id => id !== entry.id)];
  return { text, evidence: { version: readback.version, traceIds, spanIds } };
}
