// Tailor agent seam contract. Owner: orchestrator / NIT-270. Frozen snapshot for NIT-272 / NIT-273 / NIT-271.
// Change requests go through the orchestrator; do not edit concurrently from a lane.
//
// Flow per buyer turn (server-side, one product agent):
//   request -> [knowledge + context load] -> model proposes a bounded action
//   -> deterministic validation / tools (code enforces everything that matters)
//   -> transactional save -> INDEPENDENT readback -> grounded explanation.
// The model never holds session IDs, never picks persisted IDs and cannot bypass the validator.

import type {
  ChatTurn, Clarification, Dataset, DemoSession, Evidence, Json, OutcomeKind, ScenarioKey,
  SpanKind, SpanStatus, Story, Trace, TraceList, TraceQuery,
} from './contracts.ts';

export const CONTRACT_VERSION = '2026-10-11.1' as const;

// ---------------------------------------------------------------------------
// Limits. Finite, code-enforced. Provider names and money budgets stay unset until approved.
// ---------------------------------------------------------------------------
export const LIMITS = {
  // Session lifecycle (server clock is authoritative; client/model claims are ignored).
  idleMs: 60 * 60 * 1000,
  lifetimeMs: 4 * 60 * 60 * 1000,
  /** Sweep cadence for deleting ended/expired sessions without a revisit. */
  sweepIntervalMs: 5 * 60 * 1000,
  // Conversation.
  maxConversationTurns: 120,
  maxTurnTextChars: 2000,
  /** One buyer turn in flight per session; a second concurrent turn gets TURN_IN_FLIGHT. */
  maxInFlightTurnsPerSession: 1,
  // Agent loop per turn.
  maxProviderCallsPerTurn: 3,
  maxToolCallsPerTurn: 6,
  /** Validator rejections the model may repair before the turn fails truthfully. */
  maxRepairsPerTurn: 2,
  /** Escalation to a stronger model is allowed at most once per turn and only after a repair failed. */
  maxEscalationsPerTurn: 1,
  maxOutputTokens: 4000,
  // Scenario data bounds.
  maxTracesPerDataset: 4,
  maxSpansPerTrace: 24,
  maxSpanJsonBytes: 4096,
  maxNameChars: 120,
  maxLabelChars: 60,
  maxErrorChars: 400,
  maxTagChars: 32,
  maxTagsPerTrace: 8,
  maxRootDurationMs: 600_000,
  maxAssumptions: 6,
  maxStoryChars: 600,
  // Knowledge retrieval.
  maxKnowledgeRecordsPerTurn: 6,
  // Telemetry.
  telemetryQueueMax: 200,
  telemetryExportRetries: 2,
} as const;

export const SCENARIO_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SPAN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SPAN_KINDS: readonly SpanKind[] = ['WORKFLOW', 'GUARDRAIL', 'TOOL', 'RETRIEVAL', 'CHAIN', 'AGENT', 'LLM'];
export const OUTCOME_KINDS: readonly OutcomeKind[] = ['success', 'degraded', 'failure', 'escalation'];
/** Hosts allowed inside fictional URLs (RFC 2606/6761 reserved). Anything else with "://" is rejected. */
export const FICTIONAL_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)(?:\.[a-z]+)?$/i;

// ---------------------------------------------------------------------------
// Scenario proposal: what the model may author. Code assigns IDs and timestamps.
// ---------------------------------------------------------------------------
export interface ProposedSpan {
  /** Stable key within the trace. Persisted ID = `${sessionId}-${traceKey}-${spanKey}`. */
  key: string;
  /** null for the single root span. */
  parentKey: string | null;
  name: string;
  kind: SpanKind;
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  input: Json;
  output: Json;
  /** Required non-null when status=ERROR, null otherwise. Prefixed "SYNTHETIC:" by the validator if missing. */
  error: string | null;
  /** Marks a span the fictional product would surface as a detection ("Execution Failed"). Only valid on ERROR spans. */
  detection: boolean;
}
export interface ProposedTrace {
  /** Persisted ID = `${sessionId}-${key}`. */
  key: ScenarioKey;
  label: string;
  name: string;
  outcome: string;
  outcomeKind: OutcomeKind;
  tags: string[];
  input: Json;
  /** Must deep-equal the root span output. */
  output: Json;
  spans: ProposedSpan[];
}
export interface ScenarioProposal {
  kind: 'scenario_proposal';
  contractVersion: typeof CONTRACT_VERSION;
  /** Dataset version the proposal was built against. Mismatch => conflict, nothing written. */
  expectedVersion: number;
  /** 'new' replaces the dataset; 'edit' must keep every trace key that it does not list in `removeTraceKeys`. */
  mode: 'new' | 'edit';
  removeTraceKeys?: ScenarioKey[];
  story: Story;
  activeScenario: ScenarioKey;
  /** Full definitions of new or changed traces. Unchanged traces (mode=edit) are carried over by code. */
  traces: ProposedTrace[];
}

export type ValidationProblem = { path: string; code: ValidationCode; message: string };
export type ValidationCode =
  | 'SCHEMA' | 'LIMIT' | 'DUPLICATE_KEY' | 'MISSING_ROOT' | 'MULTIPLE_ROOTS' | 'UNKNOWN_PARENT' | 'CYCLE'
  | 'TIMING' | 'STATUS_ERROR_MISMATCH' | 'DETECTION_WITHOUT_ERROR' | 'OUTCOME_INCONSISTENT' | 'OUTPUT_MISMATCH'
  | 'EXECUTABLE_CONTENT' | 'ARBITRARY_URL' | 'UNSUPPORTED_CAPABILITY' | 'ACTIVE_SCENARIO_UNKNOWN';

// ---------------------------------------------------------------------------
// Tool results. Success REQUIRES authoritative saved evidence from an independent read.
// ---------------------------------------------------------------------------
export type PublishResult =
  | { state: 'committed'; version: number; readback: ReadbackEvidence }
  | { state: 'rejected'; problems: ValidationProblem[]; version: number }
  | { state: 'conflict'; currentVersion: number }
  | { state: 'save_failed'; version: number; reason: string }
  /** Transaction may have committed; the independent read failed. Caller must NOT claim unchanged or success. */
  | { state: 'readback_uncertain'; attemptedVersion: number; lastKnownVersion: number; reason: string }
  | { state: 'expired' }
  | { state: 'unsupported'; reason: string };

export interface ReadbackEvidence extends Evidence {
  activeScenario: ScenarioKey;
  /** Per trace: span count and root duration, read back from the list/detail path, not from the proposal. */
  traces: { id: string; key: ScenarioKey; label: string; outcome: string; outcomeKind: OutcomeKind; spanCount: number; rootDurationMs: number; errorSpanIds: string[] }[];
}

/**
 * Tools the agent may call. Implemented by the backend (NIT-273), bound to ONE authorised session on the
 * server. There is no session-ID parameter anywhere: the model cannot reach another buyer's data.
 */
export interface SessionTools {
  readSession(): Promise<SessionSnapshot>;
  readTraces(query?: TraceQuery): Promise<TraceList>;
  readTrace(traceId: string): Promise<{ version: number; trace: Trace } | null>;
  /** Validate, save transactionally, read back independently. Never partially publishes. */
  publishScenario(proposal: ScenarioProposal): Promise<PublishResult>;
  /** Validation only, no write. Used for repair loops. */
  validateProposal(proposal: ScenarioProposal): Promise<{ ok: true } | { ok: false; problems: ValidationProblem[] }>;
}
/** What the agent sees of the session. No cookie, no secret, no other sessions. */
export interface SessionSnapshot {
  id: string;
  version: number;
  conversationVersion: number;
  story: Story | null;
  dataset: Dataset;
  conversation: ChatTurn[];
  state: DemoSession['state'];
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Turn request / response envelope. Route: POST /api/sessions/:id/turns (owning cookie).
// ---------------------------------------------------------------------------
export interface TurnRequest {
  text: string;
  /** Client-generated UUID. Retrying the same ID returns the original TurnResponse (idempotent). */
  clientTurnId: string;
  /** When answering a clarification by button; free text goes in `text` instead. */
  choiceId?: string;
}
export type TurnOutcome =
  | 'answered'            // explanation/knowledge answer, no state change
  | 'clarification'       // one question, three choices, free text allowed
  | 'committed'           // scenario saved and read back
  | 'rejected'            // proposal failed validation after bounded repairs; state unchanged (verified)
  | 'save_failed'         // known failed write; state unchanged (verified)
  | 'readback_uncertain'  // maybe committed; reported as uncertain, reconciled on next read
  | 'conflict'            // version moved under us; nothing written
  | 'unsupported'         // outside clone capabilities (explain-only or unknown)
  | 'refused'             // injection / arbitrary code / cross-session / real-product mutation
  | 'expired'             // session ended or expired; access removed
  | 'provider_unavailable'; // model provider failed within budget; nothing written

export interface TurnStep {
  name: 'load_context' | 'retrieve_knowledge' | 'model' | 'validate' | 'save' | 'readback' | 'explain' | 'repair' | 'escalate';
  status: 'ok' | 'failed' | 'skipped';
  /** Short buyer-safe detail (no payloads, no reasoning transcripts). */
  detail?: string;
  durationMs?: number;
}
export interface ExecutionLabel {
  mode: 'mock' | 'live';
  provider: string;
  /** null until a live model is approved and configured. */
  model: string | null;
}
export interface TurnResponse {
  turnId: string;
  outcome: TurnOutcome;
  /** Dataset version after this turn (authoritative, read back). */
  version: number;
  conversationVersion: number;
  /** Turns appended by this request, in order (buyer turn first). The client appends them; it never rewrites history. */
  messages: ChatTurn[];
  clarification?: Clarification;
  evidence?: ReadbackEvidence;
  steps: TurnStep[];
  execution: ExecutionLabel;
}

/** Error codes the turn route may return in `{ error: { code, message } }`. */
export type TurnErrorCode =
  | 'TURN_IN_FLIGHT' | 'TURN_TEXT_INVALID' | 'SESSION_EXPIRED' | 'SESSION_ENDED' | 'NOT_FOUND' | 'CONVERSATION_FULL';

// ---------------------------------------------------------------------------
// Agent service seam. Implemented by NIT-272; invoked by the backend route (NIT-273).
// ---------------------------------------------------------------------------
export interface AgentTurnInput {
  session: SessionSnapshot;
  request: TurnRequest;
  tools: SessionTools;
  knowledge: KnowledgeIndex;
  telemetry: TurnTelemetry;
  clock: Clock;
  provider: ModelProvider;
  /** Optional stronger provider for one bounded escalation; absent until approved. */
  escalationProvider?: ModelProvider;
}
export interface AgentTurnResult {
  outcome: TurnOutcome;
  /** Tailor turns to append (the backend appends the buyer turn itself before invoking the agent). */
  messages: Omit<ChatTurn, 'id' | 'at'>[];
  clarification?: Clarification;
  evidence?: ReadbackEvidence;
  steps: TurnStep[];
  execution: ExecutionLabel;
  /** Updated story when a proposal committed; backend persists it with the same transaction as the turns. */
  story?: Story;
}
export interface AgentService {
  handleTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

// ---------------------------------------------------------------------------
// Model provider abstraction. Mock first; live provider/model IDs stay unset until approved.
// ---------------------------------------------------------------------------
export type AgentAction =
  | { type: 'ask'; clarification: Clarification }
  | { type: 'propose'; proposal: ScenarioProposal; explanation: string }
  | { type: 'explain'; text: string; traceId?: string; spanIds?: string[] }
  | { type: 'answer'; text: string; knowledgeIds: string[] }
  | { type: 'unsupported'; text: string; capabilityId?: string }
  | { type: 'refuse'; text: string; reason: 'injection' | 'arbitrary_code' | 'cross_session' | 'real_mutation' | 'off_topic' };

export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
export interface ProviderRequest {
  messages: ProviderMessage[];
  /** The provider must return exactly one AgentAction as JSON. */
  responseSchema: 'agent_action';
  maxOutputTokens: number;
  /** Validator problems from the previous attempt when repairing. */
  repairOf?: ValidationProblem[];
}
export interface ProviderUsage { inputTokens: number; outputTokens: number }
export interface ProviderResponse {
  action: AgentAction;
  /** Provider-reported usage only. null when not reported; never estimate. */
  usage: ProviderUsage | null;
  latencyMs: number;
}
export interface ModelProvider {
  readonly name: string;
  readonly model: string | null;
  readonly mode: 'mock' | 'live';
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Knowledge: versioned repository files, bounded slice loading, no vector store.
// ---------------------------------------------------------------------------
export type DemonstrationLevel = 'demonstrable' | 'modifiable' | 'explain_only' | 'unsupported';
export interface KnowledgeSource { url: string; verifiedOn: string; claim: string }
export interface CapabilityRecord {
  id: string;
  title: string;
  /** Official Neatlogs product capability vs. what this clone can show. */
  scope: 'official_product' | 'clone_only';
  buyerProblem: string;
  behaviour: string;
  limitations: string[];
  prerequisites: string[];
  planAvailability: { status: 'known'; plans: string[]; note?: string } | { status: 'unknown'; note: string };
  sources: KnowledgeSource[];
  exampleQuestions: string[];
  demonstration: {
    level: DemonstrationLevel;
    /** What in the clone proves it, e.g. "trace detail shows ERROR child spans and detections". */
    evidence: string;
    cloneSurfaces: string[];
    /** SessionTools methods or UI surfaces that can demonstrate/modify it. */
    tools: string[];
  };
  topics: string[];
}
export interface KnowledgeIndex {
  version: string;
  /** Keyword/topic scored selection; at most LIMITS.maxKnowledgeRecordsPerTurn. */
  select(query: string, max?: number): CapabilityRecord[];
  get(id: string): CapabilityRecord | undefined;
  all(): readonly CapabilityRecord[];
}

// ---------------------------------------------------------------------------
// Telemetry seam (real Tailor runtime observability, NOT the synthetic demo data).
// Backend owns the exporter; agent lane wraps model/retrieval/explain steps; backend wraps tool/save/readback.
// ---------------------------------------------------------------------------
export type TelemetryStep = TurnStep['name'] | 'turn';
export interface TurnTelemetry {
  /** Correlation IDs are hashed/opaque; no cookie, no raw buyer text, no full payloads by default. */
  readonly turnId: string;
  readonly correlationId: string;
  step<T>(name: TelemetryStep, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
  event(name: string, attributes: Record<string, string | number | boolean>): void;
  /** Provider usage when reported; absence is recorded as unavailable, never zero. */
  recordUsage(usage: ProviderUsage | null, model: string | null): void;
}

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

/** Type-level export so lanes can import a single module for the frozen seam. */
export type { ChatTurn, Clarification, Dataset, DemoSession, Evidence, Json, Trace, TraceList, TraceQuery };
