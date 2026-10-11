// Bounded, structured context handed to the model provider each turn.
// Summaries only: names, statuses, timings and error strings. Never cookies, never other sessions,
// never full span payloads except a size-capped view of the ONE active trace (needed for follow-up edits).
// Buyer statements and Tailor assumptions are kept in separate fields on purpose.

import type { ChatTurn, Json, Span, Story, Trace } from './contracts.ts';
import { CONTRACT_VERSION, LIMITS, type CapabilityRecord, type SessionSnapshot, type TurnRequest } from './agent-contract.ts';
import { clip } from '../../tailor/text.ts';
import { resolveTurnText as resolveCoreTurnText, type ResolvedTurnText as CoreResolvedTurnText } from '../../tailor/conversation.ts';

export { clip };

export const CONTEXT_SCHEMA_VERSION = 1 as const;
const MAX_RECENT_TURNS = 12;
const MAX_TURN_CHARS = 500;
const MAX_RECORD_BEHAVIOUR_CHARS = 500;
const MAX_IO_CHARS = 600;
const MAX_BUYER_STATEMENTS = 6;

export interface SpanSummary {
  key: string; parentKey: string | null; name: string; kind: Span['kind']; status: Span['status'];
  startMs: number; durationMs: number; detection: boolean; error: string | null;
}
export interface TraceSummary {
  key: string; label: string; outcome: string; outcomeKind: Trace['outcomeKind']; tags: string[];
  rootDurationMs: number; spanCount: number; spans: SpanSummary[]; errors: string[];
}
export interface ActiveTraceDetail {
  key: string; label: string; name: string; outcome: string; outcomeKind: Trace['outcomeKind']; tags: string[];
  input: Json; output: Json;
  spans: (SpanSummary & { input: Json; output: Json })[];
}
export interface KnowledgeSummary {
  id: string; title: string; behaviour: string; limitations: string[]; topics: string[];
  demonstrationLevel: CapabilityRecord['demonstration']['level'];
  planAvailability: CapabilityRecord['planAvailability'];
}
export interface AgentContext {
  contextSchema: typeof CONTEXT_SCHEMA_VERSION;
  contractVersion: typeof CONTRACT_VERSION;
  datasetVersion: number;
  conversationVersion: number;
  /** What the buyer said (verbatim, clipped). Facts here are buyer statements. */
  buyerStatements: string[];
  /** What Tailor assumed on the buyer's behalf. Never promoted to buyer statements. */
  story: Story | null;
  recentTurns: { role: ChatTurn['role']; status: ChatTurn['status']; text: string }[];
  unresolvedQuestion: { question: string; choices: { id: string; label: string }[] } | null;
  choiceResolved: { id: string; label: string } | null;
  activeScenario: string | null;
  /** The trace the buyer has open in the UI ("this trace"); null when none. `key` is null when it is not in this dataset. */
  openTrace: { id: string; key: string | null; label: string | null } | null;
  dataset: { traces: TraceSummary[] };
  activeTrace: ActiveTraceDetail | null;
  knowledge: KnowledgeSummary[];
  knowledgeVersion: string;
  limits: Record<string, number>;
}

/** Persisted span IDs are `${traceId}-${spanKey}`; recover the model-facing key. */
export function spanKeyOf(trace: Trace, span: Span): string {
  const prefix = `${trace.id}-`;
  return span.id.startsWith(prefix) ? span.id.slice(prefix.length) : span.id;
}

function parentKeyOf(trace: Trace, span: Span): string | null {
  if (!span.parentId) return null;
  const parent = trace.spans.find(s => s.id === span.parentId);
  return parent ? spanKeyOf(trace, parent) : span.parentId;
}

function summariseSpan(trace: Trace, span: Span): SpanSummary {
  return {
    key: spanKeyOf(trace, span), parentKey: parentKeyOf(trace, span), name: span.name, kind: span.kind, status: span.status,
    startMs: span.startMs, durationMs: span.durationMs, detection: span.detection,
    error: span.error === null ? null : clip(span.error, LIMITS.maxErrorChars),
  };
}

function rootOf(trace: Trace): Span | undefined { return trace.spans.find(s => s.parentId === null); }

function summariseTrace(trace: Trace): TraceSummary {
  const spans = trace.spans.map(s => summariseSpan(trace, s));
  return {
    key: trace.scenario, label: trace.label, outcome: trace.outcome, outcomeKind: trace.outcomeKind, tags: trace.tags.slice(0, LIMITS.maxTagsPerTrace),
    rootDurationMs: rootOf(trace)?.durationMs ?? 0, spanCount: trace.spans.length, spans,
    errors: spans.filter(s => s.error !== null).map(s => `${s.name}: ${s.error}`),
  };
}

function bounded(value: Json): Json {
  const text = JSON.stringify(value) ?? 'null';
  return text.length <= MAX_IO_CHARS ? value : '[truncated]';
}

function detailOf(trace: Trace): ActiveTraceDetail {
  const ordered = [...trace.spans].sort((a, b) => a.startMs - b.startMs);
  return {
    key: trace.scenario, label: trace.label, name: trace.name, outcome: trace.outcome, outcomeKind: trace.outcomeKind, tags: trace.tags.slice(0, LIMITS.maxTagsPerTrace),
    input: bounded(trace.input), output: bounded(trace.output),
    spans: ordered.map(s => ({ ...summariseSpan(trace, s), input: bounded(s.input), output: bounded(s.output) })),
  };
}

export function summariseRecord(record: CapabilityRecord): KnowledgeSummary {
  return {
    id: record.id, title: record.title, behaviour: clip(record.behaviour, MAX_RECORD_BEHAVIOUR_CHARS),
    limitations: record.limitations.slice(0, 4).map(l => clip(l, 200)), topics: record.topics.slice(0, 10),
    demonstrationLevel: record.demonstration.level, planAvailability: record.planAvailability,
  };
}

export type ResolvedTurnText = CoreResolvedTurnText<ChatTurn>;

/** The core's choice/free-text resolution, typed for the Neatlogs session. */
export function resolveTurnText(session: SessionSnapshot, request: TurnRequest): ResolvedTurnText {
  return resolveCoreTurnText(session, request);
}

export function buildContext(args: { session: SessionSnapshot; resolved: ResolvedTurnText; records: CapabilityRecord[]; knowledgeVersion: string; openTraceId?: string }): AgentContext {
  const { session, resolved, records } = args;
  const active = session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario) ?? null;
  const openId = args.openTraceId?.trim();
  const open = openId ? session.dataset.traces.find(t => t.id === openId) ?? null : null;
  const recent = resolved.history.slice(-MAX_RECENT_TURNS);
  return {
    contextSchema: CONTEXT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    datasetVersion: session.version,
    conversationVersion: session.conversationVersion,
    buyerStatements: resolved.history.filter(t => t.role === 'buyer').slice(-MAX_BUYER_STATEMENTS).map(t => clip(t.text, MAX_TURN_CHARS)),
    story: session.story,
    recentTurns: recent.map(t => ({ role: t.role, status: t.status, text: clip(t.text, MAX_TURN_CHARS) })),
    unresolvedQuestion: resolved.question ? { question: resolved.question.question, choices: resolved.question.choices.map(c => ({ id: c.id, label: c.label })) } : null,
    choiceResolved: resolved.choice,
    activeScenario: active ? active.scenario : null,
    openTrace: openId ? { id: clip(openId, 200), key: open ? open.scenario : null, label: open ? open.label : null } : null,
    dataset: { traces: session.dataset.traces.slice(0, LIMITS.maxTracesPerDataset).map(summariseTrace) },
    activeTrace: active ? detailOf(active) : null,
    knowledge: records.slice(0, LIMITS.maxKnowledgeRecordsPerTurn).map(summariseRecord),
    knowledgeVersion: args.knowledgeVersion,
    limits: {
      maxTracesPerDataset: LIMITS.maxTracesPerDataset, maxSpansPerTrace: LIMITS.maxSpansPerTrace, maxSpanJsonBytes: LIMITS.maxSpanJsonBytes,
      maxNameChars: LIMITS.maxNameChars, maxLabelChars: LIMITS.maxLabelChars, maxErrorChars: LIMITS.maxErrorChars, maxTagsPerTrace: LIMITS.maxTagsPerTrace,
      maxTagChars: LIMITS.maxTagChars, maxRootDurationMs: LIMITS.maxRootDurationMs, maxAssumptions: LIMITS.maxAssumptions, maxStoryChars: LIMITS.maxStoryChars,
    },
  };
}
