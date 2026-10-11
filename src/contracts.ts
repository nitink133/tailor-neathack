// Shared data contracts for the Tailor demo. Owner: orchestrator / NIT-270.
// Contract snapshot: see CONTRACT_VERSION in ./agent-contract.ts and docs/nit-269-contract.md.
// Everything persisted in SQLite and projected by the UI derives from DemoSession.

/** The two regression fixtures kept from NIT-265. Personalised scenarios use arbitrary ScenarioKey slugs. */
export type FixtureScenario = 'recovered' | 'exhausted';
/** Lower-case slug, 1–40 chars of [a-z0-9-]. Unique within a session dataset. */
export type ScenarioKey = string;
/** Kept for backwards compatibility with NIT-265 code; now any ScenarioKey. */
export type Scenario = ScenarioKey;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type SpanKind = 'WORKFLOW' | 'GUARDRAIL' | 'TOOL' | 'RETRIEVAL' | 'CHAIN' | 'AGENT' | 'LLM';
export type SpanStatus = 'OK' | 'ERROR';
/** Buyer-facing outcome class. Derived checks in the validator depend on it. */
export type OutcomeKind = 'success' | 'degraded' | 'failure' | 'escalation';

export interface Span {
  id: string; parentId: string | null; name: string;
  kind: SpanKind;
  startMs: number; durationMs: number; status: SpanStatus;
  input: Json; output: Json; error: string | null; detection: boolean;
}
export interface Trace {
  id: string; sessionId: string; scenario: ScenarioKey;
  /** Short buyer-facing label, e.g. "Retry recovers" or "Both attempts fail". */
  label: string;
  name: string;
  ingestedAt: string; status: 'Ready';
  /** Slug such as order_found, booking_confirmed, escalation_required. */
  outcome: string;
  outcomeKind: OutcomeKind;
  tags: string[]; input: Json; output: Json; spans: Span[];
}
export interface Dataset { activeScenario: ScenarioKey; traces: Trace[] }

/** Fictional context the agent preserves across follow-up edits. Never contains real buyer identifiers. */
export interface Story {
  /** Buyer-stated domain in their own words, e.g. "travel-booking agent". */
  domain: string;
  /** One or two sentences summarising the fictional workflow. */
  summary: string;
  /** Explicit assumptions Tailor made that the buyer did not state (kept separate from buyer statements). */
  assumptions: string[];
}

export type ChatRole = 'buyer' | 'tailor';
/**
 * pending: buyer request whose effect is not yet verified.
 * applied: a change was committed AND independently read back.
 * failed: rejected or known-failed; last good state retained.
 * uncertain: save may have committed but readback failed; reconciled later.
 * question: Tailor asked one clarification (carries `clarification`).
 * note: informational message with no state change.
 */
export type ChatStatus = 'pending' | 'applied' | 'failed' | 'uncertain' | 'question' | 'note';
export interface ClarificationChoice { id: string; label: string }
export interface Clarification {
  question: string;
  /** Exactly three relevant choices. */
  choices: [ClarificationChoice, ClarificationChoice, ClarificationChoice];
  allowFreeText: true;
}
export interface ChatTurn {
  id: string;
  role: ChatRole;
  text: string;
  status: ChatStatus;
  at: string;
  /** Present only on role=tailor status=question turns. */
  clarification?: Clarification;
  /** Present on tailor turns that explain or confirm saved state. IDs are real saved evidence. */
  evidence?: Evidence;
}
export interface Evidence {
  version: number;
  traceIds: string[];
  spanIds: string[];
}

export type SessionState = 'active' | 'ended' | 'expired';
export interface DemoSession {
  id: string;
  description: string;
  createdAt: string;
  /** Dataset (scenario) version. Bumped only by accepted scenario publications. */
  version: number;
  dataset: Dataset;
  conversation: ChatTurn[];
  /** Bumped on every accepted conversation append. Used for turn concurrency. */
  conversationVersion: number;
  /** True once the server trimmed old turns to stay inside LIMITS.maxConversationTurns. */
  conversationTruncated: boolean;
  story: Story | null;
  state: SessionState;
  /** Server clock, ISO. Reads and turns refresh lastActiveAt. */
  lastActiveAt: string;
  /** createdAt + LIMITS.lifetimeMs. Hard cap irrespective of activity. */
  expiresAt: string;
  /** Last accepted turn ID per client turn, for idempotent retries. */
  lastClientTurnId: string | null;
}

export interface CreateSession { description: string; scenario?: FixtureScenario }
/** Developer-only raw dataset proposal retained from NIT-265 (validated by the same validator as agent proposals). */
export interface Proposal { expectedVersion: number; dataset: Dataset }
export interface TraceQuery { q?: string; scenario?: ScenarioKey; detection?: 'yes' | 'no'; tag?: string; minMs?: number; maxMs?: number }
export interface TraceList { version: number; activeScenario: ScenarioKey; total: number; filtered: number; traces: Trace[] }
export interface ApiError { error: { code: string; message: string } }
