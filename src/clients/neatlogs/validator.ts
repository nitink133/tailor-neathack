// Deterministic validator for agent-authored scenario proposals and developer raw datasets (NIT-273).
// Proposals are untrusted JSON: code, never the model, enforces schema, limits, coherence and content rules,
// and code derives every persisted ID and timestamp.
import type { Dataset, Json, Span, Story, Trace } from './contracts.ts';
import {
  CONTRACT_VERSION, FICTIONAL_HOST_PATTERN, LIMITS, OUTCOME_KINDS, SCENARIO_KEY_PATTERN, SPAN_KEY_PATTERN, SPAN_KINDS,
  type Clock, type ValidationCode, type ValidationProblem,
} from './agent-contract.ts';

const MAX_PROBLEMS = 50;
const MAX_DEPTH = 24;
const MAX_PROPOSAL_BYTES = 512 * 1024;
const REQUIRED_TAGS = ['synthetic', 'tailor-demo'] as const;
const OUTCOME_PATTERN = /^[a-z][a-z0-9_-]{0,59}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/i;
const EPSILON = 1e-9;

const EXECUTABLE_PATTERNS: readonly RegExp[] = [
  /<script/i, /javascript:/i, /data:text\/html/i, /```/, /\brequire\s*\(/, /\bimport\s*\(/, /\beval\s*\(/,
  /child_process/i, /process\.env/i, /\brm\s+-rf\b/i, /\$\(/,
];
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/([^\s/"'?#<>\\]*)/gi;

type Problems = { list: ValidationProblem[]; add(path: string, code: ValidationCode, message: string): void };
function problems(): Problems {
  const list: ValidationProblem[] = [];
  return { list, add(path, code, message) { if (list.length < MAX_PROBLEMS) list.push({ path, code, message }); } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => isJson(v, depth + 1));
  if (isRecord(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(v => isJson(v, depth + 1));
  }
  return false;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** Scans every string (keys included) for executable content and non-fictional URLs. */
function scanContent(value: unknown, path: string, p: Problems, depth = 0): void {
  if (depth > MAX_DEPTH) { p.add(path, 'SCHEMA', 'Nesting is too deep.'); return; }
  if (typeof value === 'string') { scanString(value, path, p); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => scanContent(v, `${path}[${i}]`, p, depth + 1)); return; }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      const child = path ? `${path}.${k}` : k;
      scanString(k, child, p);
      scanContent(v, child, p, depth + 1);
    }
  }
}
function scanString(text: string, path: string, p: Problems): void {
  if (EXECUTABLE_PATTERNS.some(re => re.test(text))) p.add(path, 'EXECUTABLE_CONTENT', 'Executable or script-like content is not allowed in synthetic data.');
  for (const match of text.matchAll(URL_PATTERN)) {
    const authority = match[1] ?? '';
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').replace(/^\[|\]$/g, '');
    if (!host || !FICTIONAL_HOST_PATTERN.test(host)) p.add(path, 'ARBITRARY_URL', `URL host "${host.slice(0, 60)}" is not a reserved fictional host (*.example, *.test, *.invalid, localhost).`);
  }
}

/** Shape shared by proposal spans and persisted spans so both paths get identical coherence checks. */
interface GenericSpan {
  key: string; parentKey: string | null; name: string; kind: string; startMs: number; durationMs: number;
  status: string; input: Json; output: Json; error: string | null; detection: boolean;
}
interface GenericTrace {
  key: string; label: string; name: string; outcome: string; outcomeKind: string; tags: string[];
  input: Json; output: Json; spans: GenericSpan[];
}

function checkSpanFields(raw: unknown, path: string, p: Problems, keyOk: (k: string) => boolean, keyField: 'key' | 'id', parentField: 'parentKey' | 'parentId'): GenericSpan | null {
  if (!isRecord(raw)) { p.add(path, 'SCHEMA', 'Span must be an object.'); return null; }
  let ok = true;
  const fail = (field: string, code: ValidationCode, message: string) => { ok = false; p.add(`${path}.${field}`, code, message); };
  const key = raw[keyField]; const parentKey = raw[parentField];
  if (typeof key !== 'string' || !keyOk(key)) fail(keyField, 'SCHEMA', keyField === 'key' ? 'Span key must be a lower-case slug (1–40 of a-z, 0-9, -).' : 'Span id must belong to this session and trace.');
  if (parentKey !== null && typeof parentKey !== 'string') fail(parentField, 'SCHEMA', 'Parent must be a string or null.');
  if (!nonEmpty(raw.name, LIMITS.maxNameChars)) fail('name', typeof raw.name === 'string' && raw.name.length > LIMITS.maxNameChars ? 'LIMIT' : 'SCHEMA', `Span name must be 1–${LIMITS.maxNameChars} characters.`);
  if (typeof raw.kind !== 'string' || !(SPAN_KINDS as readonly string[]).includes(raw.kind)) fail('kind', 'SCHEMA', `Span kind must be one of ${SPAN_KINDS.join(', ')}.`);
  if (!isFiniteNumber(raw.startMs) || raw.startMs < 0) fail('startMs', 'TIMING', 'startMs must be a finite number ≥ 0.');
  if (!isFiniteNumber(raw.durationMs) || raw.durationMs <= 0) fail('durationMs', 'TIMING', 'durationMs must be a finite number > 0.');
  if (raw.status !== 'OK' && raw.status !== 'ERROR') fail('status', 'SCHEMA', 'Status must be OK or ERROR.');
  if (!isJson(raw.input)) fail('input', 'SCHEMA', 'Span input must be JSON.');
  if (!isJson(raw.output)) fail('output', 'SCHEMA', 'Span output must be JSON.');
  if (raw.error !== null && !(typeof raw.error === 'string' && raw.error.trim())) fail('error', 'SCHEMA', 'Error must be null or non-empty text.');
  else if (typeof raw.error === 'string' && raw.error.length > LIMITS.maxErrorChars) fail('error', 'LIMIT', `Error text exceeds ${LIMITS.maxErrorChars} characters.`);
  if (typeof raw.detection !== 'boolean') fail('detection', 'SCHEMA', 'detection must be a boolean.');
  if (isJson(raw.input) && isJson(raw.output) && Buffer.byteLength(JSON.stringify({ input: raw.input, output: raw.output })) > LIMITS.maxSpanJsonBytes) fail('input', 'LIMIT', `Span input+output exceed ${LIMITS.maxSpanJsonBytes} JSON bytes.`);
  if (!ok) return null;
  return {
    key: key as string, parentKey: parentKey as string | null, name: raw.name as string, kind: raw.kind as string,
    startMs: raw.startMs as number, durationMs: raw.durationMs as number, status: raw.status as string,
    input: raw.input as Json, output: raw.output as Json, error: raw.error as string | null, detection: raw.detection as boolean,
  };
}

/** Coherence across spans of one trace: root, parents, cycles, timing, ERROR⇔error, detections, outcome, output. */
function checkCoherence(t: GenericTrace, path: string, p: Problems): void {
  const byKey = new Map<string, GenericSpan>();
  t.spans.forEach((s, i) => {
    if (byKey.has(s.key)) p.add(`${path}.spans[${i}]`, 'DUPLICATE_KEY', `Duplicate span key "${s.key}".`);
    else byKey.set(s.key, s);
  });
  const roots = t.spans.filter(s => s.parentKey === null);
  if (roots.length === 0) p.add(`${path}.spans`, 'MISSING_ROOT', 'Exactly one root span (parent null) is required.');
  if (roots.length > 1) p.add(`${path}.spans`, 'MULTIPLE_ROOTS', `Found ${roots.length} root spans; exactly one is allowed.`);
  const root = roots[0];
  if (root) {
    if (root.startMs !== 0) p.add(`${path}.spans`, 'TIMING', 'The root span must start at 0 ms.');
    if (root.durationMs > LIMITS.maxRootDurationMs) p.add(`${path}.spans`, 'LIMIT', `Root duration exceeds ${LIMITS.maxRootDurationMs} ms.`);
    if (!jsonEqual(root.output, t.output)) p.add(`${path}.output`, 'OUTPUT_MISMATCH', 'Trace output must equal the root span output.');
  }
  t.spans.forEach((s, i) => {
    const sp = `${path}.spans[${i}]`;
    if (s.parentKey !== null) {
      const parent = byKey.get(s.parentKey);
      if (s.parentKey === s.key) p.add(sp, 'CYCLE', `Span "${s.key}" is its own parent.`);
      else if (!parent) p.add(sp, 'UNKNOWN_PARENT', `Parent "${s.parentKey}" does not exist in this trace.`);
      else if (s.startMs < parent.startMs - EPSILON || s.startMs + s.durationMs > parent.startMs + parent.durationMs + EPSILON) p.add(sp, 'TIMING', `Span "${s.key}" must fit inside its parent's time range.`);
    }
    if ((s.status === 'ERROR') !== (s.error !== null)) p.add(sp, 'STATUS_ERROR_MISMATCH', 'status ERROR requires error text, and error text requires status ERROR.');
    if (s.detection && s.status !== 'ERROR') p.add(sp, 'DETECTION_WITHOUT_ERROR', 'Detections are only valid on ERROR spans.');
  });
  // Cycle detection along parent chains (catches loops disconnected from the root).
  const reported = new Set<string>();
  for (const s of t.spans) {
    const seen = new Set<string>();
    let cur: GenericSpan | undefined = s;
    while (cur && cur.parentKey !== null) {
      if (seen.has(cur.key)) {
        if (!reported.has(cur.key) && cur.parentKey !== cur.key) { reported.add(cur.key); p.add(`${path}.spans`, 'CYCLE', `Parent links form a cycle through "${cur.key}".`); }
        break;
      }
      seen.add(cur.key);
      cur = byKey.get(cur.parentKey);
    }
  }
  const errors = t.spans.filter(s => s.status === 'ERROR').length;
  if ((t.outcomeKind === 'failure' || t.outcomeKind === 'escalation') && errors === 0) p.add(`${path}.outcomeKind`, 'OUTCOME_INCONSISTENT', `outcomeKind "${t.outcomeKind}" requires at least one ERROR span.`);
  if (t.outcomeKind === 'success' && root && root.status !== 'OK') p.add(`${path}.outcomeKind`, 'OUTCOME_INCONSISTENT', 'outcomeKind "success" requires the root span to be OK.');
}

function checkTraceFields(raw: Record<string, unknown>, path: string, p: Problems, keyField: 'key' | 'scenario'): boolean {
  let ok = true;
  const fail = (field: string, code: ValidationCode, message: string) => { ok = false; p.add(`${path}.${field}`, code, message); };
  if (typeof raw[keyField] !== 'string' || !SCENARIO_KEY_PATTERN.test(raw[keyField] as string)) fail(keyField, 'SCHEMA', 'Trace key must be a lower-case slug (1–40 of a-z, 0-9, -).');
  if (!nonEmpty(raw.label, LIMITS.maxLabelChars)) fail('label', typeof raw.label === 'string' && raw.label.length > LIMITS.maxLabelChars ? 'LIMIT' : 'SCHEMA', `Label must be 1–${LIMITS.maxLabelChars} characters.`);
  if (!nonEmpty(raw.name, LIMITS.maxNameChars)) fail('name', typeof raw.name === 'string' && raw.name.length > LIMITS.maxNameChars ? 'LIMIT' : 'SCHEMA', `Name must be 1–${LIMITS.maxNameChars} characters.`);
  if (typeof raw.outcome !== 'string' || !OUTCOME_PATTERN.test(raw.outcome)) fail('outcome', 'SCHEMA', 'Outcome must be a slug such as booking_confirmed.');
  if (typeof raw.outcomeKind !== 'string' || !(OUTCOME_KINDS as readonly string[]).includes(raw.outcomeKind)) fail('outcomeKind', 'SCHEMA', `outcomeKind must be one of ${OUTCOME_KINDS.join(', ')}.`);
  if (!Array.isArray(raw.tags)) fail('tags', 'SCHEMA', 'Tags must be an array.');
  else raw.tags.forEach((tag, i) => {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) fail(`tags[${i}]`, 'SCHEMA', 'Tags are short slugs.');
    else if (tag.length > LIMITS.maxTagChars) fail(`tags[${i}]`, 'LIMIT', `Tags are at most ${LIMITS.maxTagChars} characters.`);
  });
  if (!isJson(raw.input)) fail('input', 'SCHEMA', 'Trace input must be JSON.');
  if (!isJson(raw.output)) fail('output', 'SCHEMA', 'Trace output must be JSON.');
  if (!Array.isArray(raw.spans) || raw.spans.length === 0) fail('spans', 'SCHEMA', 'A trace needs at least one span.');
  else if (raw.spans.length > LIMITS.maxSpansPerTrace) fail('spans', 'LIMIT', `A trace has at most ${LIMITS.maxSpansPerTrace} spans.`);
  return ok;
}

export function storyProblems(story: unknown, path = 'story'): ValidationProblem[] {
  const p = problems();
  if (!isRecord(story)) { p.add(path, 'SCHEMA', 'Story must be an object.'); return p.list; }
  if (!nonEmpty(story.domain, LIMITS.maxNameChars)) p.add(`${path}.domain`, 'SCHEMA', `Story domain must be 1–${LIMITS.maxNameChars} characters.`);
  if (!nonEmpty(story.summary, LIMITS.maxStoryChars)) p.add(`${path}.summary`, 'SCHEMA', 'Story summary must be non-empty text.');
  if (!Array.isArray(story.assumptions) || story.assumptions.some(a => !nonEmpty(a, LIMITS.maxStoryChars))) p.add(`${path}.assumptions`, 'SCHEMA', 'Assumptions must be an array of non-empty strings.');
  else if (story.assumptions.length > LIMITS.maxAssumptions) p.add(`${path}.assumptions`, 'LIMIT', `At most ${LIMITS.maxAssumptions} assumptions.`);
  if (p.list.length === 0) {
    const s = story as unknown as Story;
    const chars = s.domain.length + s.summary.length + s.assumptions.reduce((n, a) => n + a.length, 0);
    if (chars > LIMITS.maxStoryChars) p.add(path, 'LIMIT', `Story exceeds ${LIMITS.maxStoryChars} characters.`);
  }
  return p.list;
}

const withPrefix = (text: string, prefix: string, test: string) => text.startsWith(test) ? text : `${prefix}${text}`;
const sortSpans = (spans: Span[]) => [...spans].sort((a, b) => (a.parentId === null ? -1 : 0) - (b.parentId === null ? -1 : 0) || a.startMs - b.startMs);
const keyOfTrace = (sessionId: string, t: Trace) => t.id.startsWith(`${sessionId}-`) ? t.id.slice(sessionId.length + 1) : t.scenario;

export type ProposalVerdict = { ok: true; dataset: Dataset } | { ok: false; problems: ValidationProblem[] };

/**
 * Validates an untrusted ScenarioProposal against the session's current dataset and returns the normalised
 * dataset that would be persisted. mode 'new' replaces; mode 'edit' carries over every current trace that is
 * neither removed nor redefined.
 */
export function validateProposal(sessionId: string, current: Dataset, proposal: unknown, clock: Clock): ProposalVerdict {
  const p = problems();
  if (!isRecord(proposal)) return { ok: false, problems: [{ path: '', code: 'SCHEMA', message: 'Proposal must be a JSON object.' }] };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(proposal)); } catch { return { ok: false, problems: [{ path: '', code: 'SCHEMA', message: 'Proposal must be serialisable JSON.' }] }; }
  if (size > MAX_PROPOSAL_BYTES) return { ok: false, problems: [{ path: '', code: 'LIMIT', message: `Proposal exceeds ${MAX_PROPOSAL_BYTES} bytes.` }] };
  scanContent(proposal, '', p);

  if (proposal.kind !== 'scenario_proposal') p.add('kind', 'SCHEMA', 'kind must be "scenario_proposal".');
  if (proposal.contractVersion !== CONTRACT_VERSION) p.add('contractVersion', 'SCHEMA', `contractVersion must be "${CONTRACT_VERSION}".`);
  if (!Number.isInteger(proposal.expectedVersion) || (proposal.expectedVersion as number) < 1) p.add('expectedVersion', 'SCHEMA', 'expectedVersion must be a positive integer.');
  const mode = proposal.mode;
  if (mode !== 'new' && mode !== 'edit') p.add('mode', 'SCHEMA', 'mode must be "new" or "edit".');
  const remove: string[] = [];
  if (proposal.removeTraceKeys !== undefined) {
    if (!Array.isArray(proposal.removeTraceKeys) || proposal.removeTraceKeys.some(k => typeof k !== 'string' || !SCENARIO_KEY_PATTERN.test(k))) p.add('removeTraceKeys', 'SCHEMA', 'removeTraceKeys must be an array of trace keys.');
    else if (mode === 'new' && proposal.removeTraceKeys.length > 0) p.add('removeTraceKeys', 'SCHEMA', 'removeTraceKeys only applies to mode "edit".');
    else remove.push(...(proposal.removeTraceKeys as string[]));
  }
  for (const problem of storyProblems(proposal.story)) p.add(problem.path, problem.code, problem.message);
  if (typeof proposal.activeScenario !== 'string' || !SCENARIO_KEY_PATTERN.test(proposal.activeScenario)) p.add('activeScenario', 'SCHEMA', 'activeScenario must be a trace key.');

  const rawTraces = proposal.traces;
  const proposed: GenericTrace[] = [];
  if (!Array.isArray(rawTraces)) p.add('traces', 'SCHEMA', 'traces must be an array.');
  else if (mode === 'new' && rawTraces.length === 0) p.add('traces', 'SCHEMA', 'mode "new" needs at least one trace.');
  else if (rawTraces.length > LIMITS.maxTracesPerDataset) p.add('traces', 'LIMIT', `At most ${LIMITS.maxTracesPerDataset} traces.`);
  else {
    const keys = new Set<string>();
    rawTraces.forEach((raw, ti) => {
      const path = `traces[${ti}]`;
      if (!isRecord(raw)) { p.add(path, 'SCHEMA', 'Trace must be an object.'); return; }
      const traceOk = checkTraceFields(raw, path, p, 'key');
      if (typeof raw.key === 'string') {
        if (keys.has(raw.key)) p.add(`${path}.key`, 'DUPLICATE_KEY', `Duplicate trace key "${raw.key}".`);
        keys.add(raw.key);
      }
      if (!Array.isArray(raw.spans)) return;
      const spans = raw.spans.slice(0, LIMITS.maxSpansPerTrace).map((s, si) => checkSpanFields(s, `${path}.spans[${si}]`, p, k => SPAN_KEY_PATTERN.test(k), 'key', 'parentKey'));
      if (!traceOk || spans.some(s => s === null)) return;
      const t = { ...(raw as unknown as Omit<GenericTrace, 'spans'>), spans: spans as GenericSpan[] };
      const name = withPrefix(t.name, 'SYNTHETIC ', 'SYNTHETIC ');
      if (name.length > LIMITS.maxNameChars) p.add(`${path}.name`, 'LIMIT', `Name exceeds ${LIMITS.maxNameChars} characters after the SYNTHETIC prefix.`);
      const tags = new Set([...REQUIRED_TAGS, ...t.tags]);
      if (tags.size > LIMITS.maxTagsPerTrace) p.add(`${path}.tags`, 'LIMIT', `At most ${LIMITS.maxTagsPerTrace} tags including "synthetic" and "tailor-demo".`);
      t.spans.forEach((s, si) => {
        if (s.error !== null && withPrefix(s.error, 'SYNTHETIC: ', 'SYNTHETIC:').length > LIMITS.maxErrorChars) p.add(`${path}.spans[${si}].error`, 'LIMIT', `Error exceeds ${LIMITS.maxErrorChars} characters after the SYNTHETIC prefix.`);
        if (s.parentKey === null && withPrefix(s.name, 'SYNTHETIC ', 'SYNTHETIC ').length > LIMITS.maxNameChars) p.add(`${path}.spans[${si}].name`, 'LIMIT', `Root name exceeds ${LIMITS.maxNameChars} characters after the SYNTHETIC prefix.`);
      });
      checkCoherence(t, path, p);
      proposed.push(t);
    });
  }

  const currentByKey = new Map(current.traces.map(t => [keyOfTrace(sessionId, t), t] as const));
  if (mode === 'edit') for (const key of remove) if (!currentByKey.has(key)) p.add('removeTraceKeys', 'SCHEMA', `Trace "${key}" is not in the current dataset.`);
  if (p.list.length) return { ok: false, problems: p.list };

  const ingestedAt = new Date(clock.now()).toISOString();
  const normalised = new Map<string, Trace>(proposed.map(t => [t.key, normaliseTrace(sessionId, t, ingestedAt)]));
  const traces: Trace[] = [];
  if (mode === 'edit') {
    for (const [key, t] of currentByKey) {
      if (remove.includes(key)) continue;
      const replacement = normalised.get(key);
      traces.push(replacement ?? t);
      normalised.delete(key);
    }
  }
  traces.push(...normalised.values());
  if (traces.length === 0) p.add('traces', 'SCHEMA', 'The resulting dataset needs at least one trace.');
  if (traces.length > LIMITS.maxTracesPerDataset) p.add('traces', 'LIMIT', `The resulting dataset exceeds ${LIMITS.maxTracesPerDataset} traces.`);
  if (!traces.some(t => t.scenario === proposal.activeScenario)) p.add('activeScenario', 'ACTIVE_SCENARIO_UNKNOWN', `activeScenario "${String(proposal.activeScenario)}" is not a trace in the resulting dataset.`);
  if (p.list.length) return { ok: false, problems: p.list };
  return { ok: true, dataset: { activeScenario: proposal.activeScenario as string, traces } };
}

function normaliseTrace(sessionId: string, t: GenericTrace, ingestedAt: string): Trace {
  const id = `${sessionId}-${t.key}`;
  const spans: Span[] = t.spans.map(s => ({
    id: `${id}-${s.key}`, parentId: s.parentKey === null ? null : `${id}-${s.parentKey}`,
    name: s.parentKey === null ? withPrefix(s.name, 'SYNTHETIC ', 'SYNTHETIC ') : s.name,
    kind: s.kind as Span['kind'], startMs: s.startMs, durationMs: s.durationMs, status: s.status as Span['status'],
    input: structuredClone(s.input), output: structuredClone(s.output),
    error: s.error === null ? null : withPrefix(s.error, 'SYNTHETIC: ', 'SYNTHETIC:'), detection: s.detection,
  }));
  return {
    id, sessionId, scenario: t.key, label: t.label, name: withPrefix(t.name, 'SYNTHETIC ', 'SYNTHETIC '),
    ingestedAt, status: 'Ready', outcome: t.outcome, outcomeKind: t.outcomeKind as Trace['outcomeKind'],
    tags: [...new Set([...REQUIRED_TAGS, ...t.tags])], input: structuredClone(t.input), output: structuredClone(t.output),
    spans: sortSpans(spans),
  };
}

/** Problems for an already-concrete Dataset (developer raw route, fixtures). IDs must belong to `sessionId`. */
export function datasetProblems(sessionId: string, value: unknown): ValidationProblem[] {
  const p = problems();
  if (!isRecord(value)) return [{ path: '', code: 'SCHEMA', message: 'Dataset must be an object.' }];
  scanContent(value, '', p);
  if (typeof value.activeScenario !== 'string' || !SCENARIO_KEY_PATTERN.test(value.activeScenario)) p.add('activeScenario', 'SCHEMA', 'activeScenario must be a trace key.');
  const traces = value.traces;
  if (!Array.isArray(traces) || traces.length === 0) { p.add('traces', 'SCHEMA', 'traces must be a non-empty array.'); return p.list; }
  if (traces.length > LIMITS.maxTracesPerDataset) { p.add('traces', 'LIMIT', `At most ${LIMITS.maxTracesPerDataset} traces.`); return p.list; }
  const scenarios = new Set<string>();
  const spanIds = new Set<string>();
  traces.forEach((raw, ti) => {
    const path = `traces[${ti}]`;
    if (!isRecord(raw)) { p.add(path, 'SCHEMA', 'Trace must be an object.'); return; }
    const traceOk = checkTraceFields(raw, path, p, 'scenario');
    const scenario = raw.scenario as string;
    if (typeof scenario === 'string') {
      if (scenarios.has(scenario)) p.add(`${path}.scenario`, 'DUPLICATE_KEY', `Duplicate trace scenario "${scenario}".`);
      scenarios.add(scenario);
    }
    const traceId = `${sessionId}-${scenario}`;
    if (raw.id !== traceId) p.add(`${path}.id`, 'SCHEMA', 'Trace id must be derived from this session and the trace key.');
    if (raw.sessionId !== sessionId) p.add(`${path}.sessionId`, 'SCHEMA', 'Trace must belong to this session.');
    if (raw.status !== 'Ready') p.add(`${path}.status`, 'SCHEMA', 'Trace status must be Ready.');
    if (typeof raw.ingestedAt !== 'string' || Number.isNaN(Date.parse(raw.ingestedAt))) p.add(`${path}.ingestedAt`, 'SCHEMA', 'ingestedAt must be an ISO timestamp.');
    if (typeof raw.name === 'string' && !raw.name.startsWith('SYNTHETIC ')) p.add(`${path}.name`, 'SCHEMA', 'Trace name must start with "SYNTHETIC ".');
    if (Array.isArray(raw.tags) && (!raw.tags.includes('synthetic') || !raw.tags.includes('tailor-demo'))) p.add(`${path}.tags`, 'SCHEMA', 'Tags must include "synthetic" and "tailor-demo".');
    if (Array.isArray(raw.tags) && raw.tags.length > LIMITS.maxTagsPerTrace) p.add(`${path}.tags`, 'LIMIT', `At most ${LIMITS.maxTagsPerTrace} tags.`);
    if (!Array.isArray(raw.spans)) return;
    const spanIdOk = (k: string) => k.startsWith(`${traceId}-`) && SPAN_KEY_PATTERN.test(k.slice(traceId.length + 1));
    const spans = raw.spans.slice(0, LIMITS.maxSpansPerTrace).map((s, si) => checkSpanFields(s, `${path}.spans[${si}]`, p, spanIdOk, 'id', 'parentId'));
    spans.forEach((s, si) => {
      if (!s) return;
      if (spanIds.has(s.key)) p.add(`${path}.spans[${si}].id`, 'DUPLICATE_KEY', `Duplicate span id "${s.key}".`);
      spanIds.add(s.key);
      if (s.error !== null && !s.error.startsWith('SYNTHETIC:')) p.add(`${path}.spans[${si}].error`, 'SCHEMA', 'Error text must start with "SYNTHETIC:".');
      if (s.parentKey === null && !s.name.startsWith('SYNTHETIC ')) p.add(`${path}.spans[${si}].name`, 'SCHEMA', 'Root span name must start with "SYNTHETIC ".');
    });
    if (!traceOk || spans.some(s => s === null)) return;
    checkCoherence({ ...(raw as unknown as Omit<GenericTrace, 'spans' | 'key'>), key: scenario, spans: spans as GenericSpan[] }, path, p);
  });
  if (typeof value.activeScenario === 'string' && !scenarios.has(value.activeScenario)) p.add('activeScenario', 'ACTIVE_SCENARIO_UNKNOWN', `activeScenario "${value.activeScenario}" is not a trace in this dataset.`);
  return p.list;
}

export function validateDataset(sessionId: string, value: unknown): value is Dataset {
  return datasetProblems(sessionId, value).length === 0;
}
