import type { DemoSwitchConfirmation } from '../../tailor/demo-contract.ts';
export type { BrowserSession, DemoSummary, DemoSwitchConfirmation, DemoSwitchChoice, TurnIdentity, RequestIdentity } from '../../tailor/demo-contract.ts';
// Neatlogs demo seam contract. Owner: orchestrator / NIT-270. Frozen snapshot for NIT-272 / NIT-273 / NIT-271.
// Product-agnostic shapes (chat, turn envelope, provider/telemetry seams, core limits) live in src/tailor/contract.ts;
// this module specialises them for the synthetic trace demo and keeps every exported name stable for the client.
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
import {
  CORE_LIMITS,
  type CoreTurnRequest, type ExecutionLabel, type ExplanationRequest as CoreExplanationRequest, type ExplanationResponse as CoreExplanationResponse,
  type KnowledgeIndex as CoreKnowledgeIndex, type ModelProvider as CoreModelProvider, type ProviderRequest as CoreProviderRequest,
  type ProviderResponse as CoreProviderResponse, type TurnOutcome, type TurnResult, type TurnStep, type TurnTelemetry, type Clock,
} from '../../tailor/contract.ts';

export {
  systemClock,
  type Clock, type ExecutionLabel, type ProviderErrorKind, type ProviderMessage, type ProviderUsage, type TelemetryStep, type TurnOutcome, type TurnStep, type TurnTelemetry,
} from '../../tailor/contract.ts';

export const CONTRACT_VERSION = '2026-10-11.1' as const;

// ---------------------------------------------------------------------------
// Limits: the core's turn/lifecycle limits plus the scenario data bounds this product enforces.
// ---------------------------------------------------------------------------
export const SCENARIO_LIMITS = {
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
} as const;
export const LIMITS = { ...CORE_LIMITS, ...SCENARIO_LIMITS } as const;

export const SCENARIO_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SPAN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SPAN_KINDS: readonly SpanKind[] = ['WORKFLOW', 'GUARDRAIL', 'TOOL', 'RETRIEVAL', 'CHAIN', 'AGENT', 'LLM'];
export const OUTCOME_KINDS: readonly OutcomeKind[] = ['success', 'degraded', 'failure', 'escalation'];
/** Hosts allowed inside fictional URLs (RFC 2606/6761 reserved: .example, example.com/net/org, .test, .invalid, localhost). Anything else with "://" is rejected. */
export const FICTIONAL_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)$/i;

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
  /** Optional for legacy test adapters; managed demos must pass this code-owned confirmation gate. */
  prepareScenario?(proposal: ScenarioProposal): Promise<{ state: 'ready' } | { state: 'confirmation_required'; confirmation: DemoSwitchConfirmation }>;
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
export interface TurnRequest extends CoreTurnRequest {
  /** Binds a fixed confirmation choice to the persisted server-owned candidate. */
  confirmationRef?: string;
  /**
   * Trace the buyer currently has open in the UI (persisted trace id), when any. "Explain this trace" must explain
   * THIS trace; the server verifies it belongs to the session and the agent never silently substitutes the active one.
   */
  openTraceId?: string;
}

/**
 * GET /api/execution (no session needed). Authoritative provider mode for labelling the UI before the first turn and
 * across tabs/reloads. The client must never label an unknown mode as live.
 */
export interface ExecutionInfoResponse {
  execution: ExecutionLabel;
}
export interface TurnResponse {
  /** Present for browser-owned demos; older adapters may omit it. */
  demoId?: string;
  sessionId?: string;
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
  | 'TURN_IN_FLIGHT' | 'TURN_TEXT_INVALID' | 'SESSION_EXPIRED' | 'SESSION_ENDED' | 'NOT_FOUND' | 'CONVERSATION_FULL'
  /** Same clientTurnId reused with a different request body. */
  | 'IDEMPOTENCY_MISMATCH'
  /** openTraceId does not belong to this session's current dataset. */
  | 'TRACE_NOT_FOUND';

// ---------------------------------------------------------------------------
// Agent service seam. Implemented by NIT-272; invoked by the backend route (NIT-273).
// ---------------------------------------------------------------------------
export interface AgentTurnInput {
  /** Request cancellation is forwarded to the bounded core/provider calls. */
  signal?: AbortSignal;
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
export type AgentTurnResult = TurnResult<Evidence, ReadbackEvidence, Story>;
export interface AgentService {
  handleTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

// ---------------------------------------------------------------------------
// Model provider abstraction. Mock first; live provider/model IDs stay unset until approved.
// ---------------------------------------------------------------------------
export interface GuidanceSelection {
  targetId: 'trace.overview' | 'trace.slowest-span' | 'trace.model-call' | 'trace.output';
  /** Saved id only; omit to use the current authorised trace. */
  traceId?: string;
}
export type AgentAction =
  | { type: 'ask'; clarification: Clarification }
  | { type: 'propose'; proposal: ScenarioProposal; explanation: string; guidance?: GuidanceSelection[] }
  | { type: 'explain'; text: string; traceId?: string; spanIds?: string[]; guidance?: GuidanceSelection[] }
  | { type: 'answer'; text: string; knowledgeIds: string[]; guidance?: GuidanceSelection[] }
  | { type: 'unsupported'; text: string; capabilityId?: string }
  | { type: 'refuse'; text: string; reason: 'injection' | 'arbitrary_code' | 'cross_session' | 'real_mutation' | 'off_topic' };

export interface ProviderRequest extends CoreProviderRequest {
  /** The provider must return exactly one AgentAction as JSON. */
  responseSchema: 'agent_action';
  /** Validator problems from the previous attempt when repairing. */
  repairOf?: ValidationProblem[];
}
export type ProviderResponse = CoreProviderResponse<AgentAction>;
/** Second, optional call after save+readback: narrate ONLY from the evidence we pass in. */
export interface ExplanationRequest extends CoreExplanationRequest {
  responseSchema: 'evidence_explanation';
}
export interface EvidenceExplanation {
  /** 1–4 sentences for the buyer; code grounds it against the read-back trace before use. */
  text: string;
  /** Span ids the explanation relies on; must be a subset of the evidence passed in. */
  spanIds: string[];
}
export type ExplanationResponse = CoreExplanationResponse<EvidenceExplanation>;
export interface ModelProvider extends CoreModelProvider<AgentAction, EvidenceExplanation> {
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
  /** Absent on providers without a separate explanation step (mock); the core then keeps the planning explanation. */
  explain?(request: ExplanationRequest, signal?: AbortSignal): Promise<ExplanationResponse>;
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
export type KnowledgeIndex = CoreKnowledgeIndex<CapabilityRecord>;

/** Type-level export so lanes can import a single module for the frozen seam. */
export type { ChatTurn, Clarification, Dataset, DemoSession, Evidence, Json, Trace, TraceList, TraceQuery };
