// Product-agnostic Tailor contract: chat shapes, turn envelope, core limits, the model-provider and telemetry seams.
// Types and constants only (no Node imports): the browser build reaches this file through the client's contract.
// Nothing here knows what a product stores; product shapes come in through the ProductAdapter (./adapter.ts).

// ---------------------------------------------------------------------------
// Core limits. Finite, code-enforced. Product data bounds belong to the adapter.
// ---------------------------------------------------------------------------
export const CORE_LIMITS = {
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
  /** Evidence-grounded explanation call after save+readback (live providers only; mock keeps the planning text). */
  maxExplanationOutputTokens: 800,
  /** Wall-clock bound for one provider call, including provider-side thinking. */
  providerTimeoutMs: 60_000,
  /** Upper bound on prompt size we are willing to send per call; the context builder must stay under this. */
  maxInputCharsPerCall: 60_000,
  // Knowledge retrieval.
  maxKnowledgeRecordsPerTurn: 6,
  // Telemetry.
  telemetryQueueMax: 200,
  telemetryExportRetries: 2,
} as const;

// ---------------------------------------------------------------------------
// Chat shapes. `TEvidence` is the product's citation shape attached to replies.
// ---------------------------------------------------------------------------
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
  /** Server-issued reference for a persisted confirmation, when present. */
  referenceId?: string;
  kind?: 'clarification' | 'demo_switch';
  question: string;
  /** Exactly three relevant choices. */
  choices: [ClarificationChoice, ClarificationChoice, ClarificationChoice];
  allowFreeText: true;
}
export interface ChatTurn<TEvidence = unknown> {
  id: string;
  role: ChatRole;
  text: string;
  status: ChatStatus;
  at: string;
  /** Present only on role=tailor status=question turns. */
  clarification?: Clarification;
  /** Present on tailor turns that explain or confirm saved state. IDs are real saved evidence. */
  evidence?: TEvidence;
}
export type TailorMessage<TEvidence = unknown> = Omit<ChatTurn<TEvidence>, 'id' | 'at'>;

// ---------------------------------------------------------------------------
// Turn envelope.
// ---------------------------------------------------------------------------
export interface CoreTurnRequest {
  text: string;
  /** Client-generated UUID. Retrying the same ID returns the original response (idempotent). */
  clientTurnId: string;
  /** When answering a clarification by button; free text goes in `text` instead. */
  choiceId?: string;
}
/** What the core needs of a session snapshot; adapters extend it with their product state. */
export interface CoreSession {
  id: string;
  version: number;
  conversation: ChatTurn[];
}
export type TurnOutcome =
  | 'answered'            // explanation/knowledge answer, no state change
  | 'clarification'       // one question, three choices, free text allowed
  | 'committed'           // change saved and read back
  | 'rejected'            // action failed validation after bounded repairs; state unchanged (verified)
  | 'save_failed'         // known failed write; state unchanged (verified)
  | 'readback_uncertain'  // maybe committed; reported as uncertain, reconciled on next read
  | 'conflict'            // version moved under us; nothing written
  | 'unsupported'         // outside product capabilities (explain-only or unknown)
  | 'refused'             // injection / arbitrary code / cross-session / real-product mutation / unpermitted tool
  | 'expired'             // session ended or expired; access removed
  | 'provider_unavailable'; // model provider failed within budget; nothing written
export const TURN_OUTCOMES: readonly TurnOutcome[] = ['answered', 'clarification', 'committed', 'rejected', 'save_failed', 'readback_uncertain', 'conflict', 'unsupported', 'refused', 'expired', 'provider_unavailable'];

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
  /** Provider effort setting when the provider exposes one (e.g. Anthropic output_config.effort); null otherwise. */
  effort?: string | null;
}
export interface TurnResult<TEvidence = unknown, TReadback = unknown, TStory = unknown> {
  outcome: TurnOutcome;
  /** Tailor turns to append (the backend appends the buyer turn itself before invoking the agent). */
  messages: TailorMessage<TEvidence>[];
  clarification?: Clarification;
  evidence?: TReadback;
  steps: TurnStep[];
  execution: ExecutionLabel;
  /** Updated product memo when a change committed; backend persists it with the same transaction as the turns. */
  story?: TStory;
}

// ---------------------------------------------------------------------------
// Model provider seam. Providers return the product's action as decoded JSON; the adapter maps it to a core action.
// ---------------------------------------------------------------------------
export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
export interface ValidationIssue { path: string; code: string; message: string }
export interface ProviderRequest {
  messages: ProviderMessage[];
  /** Name of the adapter-supplied response schema the provider must satisfy. */
  responseSchema: string;
  maxOutputTokens: number;
  /** Validator problems from the previous attempt when repairing. */
  repairOf?: ValidationIssue[];
}
export interface ProviderUsage {
  /** Uncached input tokens as reported by the provider. */
  inputTokens: number;
  /** Output tokens as reported. Thinking is billed inside this number. */
  outputTokens: number;
  /** Provider-reported cache accounting when available; undefined means not reported, never zero. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Subset of outputTokens spent on reasoning when the provider reports it (Anthropic: usage.output_tokens_details.thinking_tokens). */
  thinkingTokens?: number;
}
export interface ProviderResponse<TAction = unknown> {
  action: TAction;
  /** Provider-reported usage only. null when not reported; never estimate. */
  usage: ProviderUsage | null;
  latencyMs: number;
  /** Provider request id for support/debugging; never contains buyer content. */
  requestId?: string;
  /** Provider stop reason when reported (e.g. Anthropic `end_turn`). */
  stopReason?: string;
  /** Cost of this call in USD when it is known (reported usage x configured rates); absent means unknown. */
  costUsd?: number;
  /** Worst-case USD reserved for this call before it was sent (live providers with a spend guard). */
  reservationUsd?: number;
}
/** Second, optional call after save+readback: narrate ONLY from the evidence passed in. */
export interface ExplanationRequest {
  messages: ProviderMessage[];
  responseSchema: string;
  maxOutputTokens: number;
}
export interface ExplanationResponse<TExplanation = unknown> {
  explanation: TExplanation;
  usage: ProviderUsage | null;
  latencyMs: number;
  requestId?: string;
  stopReason?: string;
  costUsd?: number;
  reservationUsd?: number;
}
/** Why a provider call failed. Mapped to telemetry/step detail; buyer copy stays generic. */
export type ProviderErrorKind =
  | 'auth' | 'permission' | 'billing' | 'spend_cap' | 'rate_limit' | 'overloaded' | 'timeout' | 'network'
  | 'invalid_request' | 'refusal' | 'truncated' | 'malformed' | 'context_exceeded' | 'unknown';
export interface ModelProvider<TAction = unknown, TExplanation = unknown> {
  readonly name: string;
  readonly model: string | null;
  readonly mode: 'mock' | 'live';
  /** Effort setting when the provider exposes one; null for the mock. */
  readonly effort?: string | null;
  complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse<TAction>>;
  /** Absent on providers without a separate explanation step (mock); the core then keeps the planning narrative. */
  explain?(request: ExplanationRequest, signal?: AbortSignal): Promise<ExplanationResponse<TExplanation>>;
}

// ---------------------------------------------------------------------------
// Knowledge: versioned, bounded slice loading.
// ---------------------------------------------------------------------------
export interface KnowledgeIndex<TRecord = unknown> {
  version: string;
  /** Keyword/topic scored selection; at most CORE_LIMITS.maxKnowledgeRecordsPerTurn. */
  select(query: string, max?: number): TRecord[];
  get(id: string): TRecord | undefined;
  all(): readonly TRecord[];
}

// ---------------------------------------------------------------------------
// Telemetry seam (real Tailor runtime observability, never product demo data).
// ---------------------------------------------------------------------------
/** `tool` is telemetry-only (tool selection/execution); it never appears in the buyer-visible TurnStep list. */
export type TelemetryStep = TurnStep['name'] | 'turn' | 'tool';
export interface TurnTelemetry {
  /** Correlation IDs are hashed/opaque; no cookie, no raw buyer text, no full payloads by default. */
  readonly turnId: string;
  readonly correlationId: string;
  step<T>(name: TelemetryStep, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
  event(name: string, attributes: Record<string, string | number | boolean>): void;
  /** Provider usage when reported; absence is recorded as unavailable, never zero. */
  recordUsage(usage: ProviderUsage | null, model: string | null): void;
  /**
   * Adds attributes to the innermost active step (inside `step()`'s callback), else to the turn itself. Same allowlist
   * as `step()`: ids, counts, versions and short tokens only. Optional so minimal test doubles need not implement it.
   */
  annotate?(attributes: Record<string, string | number | boolean>): void;
  /**
   * Declares code-owned identifiers (adapter id, tool ids, knowledge record ids, versions) the telemetry may export as
   * attribute values. Anything not declared is rejected or replaced, so buyer/model text can never pass as an id.
   */
  declare?(vocabulary: TelemetryVocabulary): void;
}

export interface TelemetryVocabulary {
  adapterIds?: readonly string[];
  toolNames?: readonly string[];
  recordIds?: readonly string[];
  promptVersions?: readonly string[];
  knowledgeVersions?: readonly string[];
}

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
