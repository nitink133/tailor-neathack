// Real Tailor runtime observability (NIT-273), built on the pinned neatlogs SDK (init/trace/flush/shutdown).
// Synthetic demo traces never go through here. Defaults to no network: only mode 'neatlogs' with an explicit
// apiKey from the composition root exports. Exported attributes are allowlisted; correlation IDs are opaque.
// Delivery is observable: SDK export failures/drops are folded into diagnostics(), flush()/shutdown() report a verdict
// (never `ok` after a rejected batch) and shutdown is bounded. Spans are batched (SDK default 5 s), so SIGKILL, a crash or
// any exit that bypasses shutdown() loses the current batch; graceful SIGINT/SIGTERM via main.ts flushes it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { init, trace, flush as sdkFlush, shutdown as sdkShutdown, getDeliveryDiagnostics, type MaskFunction, type TraceOptions, type TraceSpanKind } from 'neatlogs';
// Transitive dependency of neatlogs (hoisted); used only for the caller-owned local provider and exporters.
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
// Same transitive-dependency rule: the OTel global error handler is the only place background batch failures surface.
import { setGlobalErrorHandler, loggingErrorHandler } from '@opentelemetry/core';
import type { Span as OtelSpan } from '@opentelemetry/api';
import { CORE_LIMITS as LIMITS, type ProviderErrorKind, type ProviderUsage, type TelemetryStep, type TelemetryVocabulary, type TurnTelemetry } from '../tailor/contract.ts';
import { MODEL_RATES } from '../tailor/spend.ts';
import { isResolvedAnthropicModel } from '../tailor/accounting.ts';
import { createEvidenceObserver, compareEvidence, type EvidenceObserver, type EvidenceManifestSnapshot, type EvidenceComparison, type EvidenceOperation } from '../tailor/evidence.ts';

export type TelemetryMode = 'disabled' | 'captured' | 'neatlogs';
export interface TelemetryOptions {
  versions?: RuntimeVersions;
  mode: TelemetryMode;
  /** Server-side secret for opaque correlation IDs (never exported). */
  secret: string;
  endpoint?: string;
  apiKey?: string;
  /** captured mode only: replaces the default no-op success exporter (tests inject failing exporters). */
  exporter?: SpanExporter;
  /** neatlogs mode: seconds between background batch exports (SDK default 5). */
  flushIntervalSeconds?: number;
  /** Upper bound for an explicit `flush()` (default 10 000 ms). */
  flushTimeoutMs?: number;
  /** Upper bound for the whole `shutdown()` (final flush + SDK shutdown; default 5 000 ms). */
  shutdownTimeoutMs?: number;
  /** One bounded line per failure burst and one final shutdown line go here (default: stderr). Never receives payloads or keys. */
  log?: (line: string) => void;
  /**
   * Allows exact buyer input / Tailor reply text on the turn root, ONLY for turns opened with `{ synthetic: true }`
   * (a controlled, synthetic fixture). Default off. Values are still clipped and scanned for credentials/emails.
   */
  syntheticPayloads?: boolean;
}
export interface RuntimeVersions { codeVersion?: string; adapterVersion?: string; contractVersion?: string; contextSchemaVersion?: number; policyVersion?: string }
export interface TurnOptions extends RuntimeVersions {
  demoId?: string; requestId?: string; clientTurnId?: string; endUserId?: string;
  manifest?: EvidenceManifestSnapshot;
  /** Synchronous safe snapshot persistence; never receives payloads. */
  onEvidence?: (snapshot: EvidenceManifestSnapshot) => void;
  /** The caller vouches that this turn runs on a controlled synthetic fixture (see `syntheticPayloads`). */
  synthetic?: boolean;
}
/** Server-side per-turn handle: the core seam plus the synthetic-fixture payload hook. */
export interface RuntimeTurnTelemetry extends TurnTelemetry {
  /** Keyed hash of the turn id: the only turn identifier that is exported (`tailor.turn_id`). */
  readonly turnRef: string;
  readonly sessionRef: string;
  readonly demoRef: string;
  readonly requestRef: string;
  readonly clientTurnRef: string;
  readonly evidence: EvidenceObserver;
  annotate(attributes: Record<string, string | number | boolean>): void;
  declare(vocabulary: TelemetryVocabulary): void;
  /** Attaches exact synthetic input/output to the turn root when allowed; returns whether anything was attached. */
  attachSynthetic(io: { input?: string; output?: string }): boolean;
}
export interface CapturedSpan {
  name: string; traceId: string; spanId: string; parentSpanId: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status: { code: number; message?: string };
}
/**
 * Export health only. `unknown`: no export acknowledgement yet. `healthy`: export acknowledged and no known loss.
 * A flush does not prove hosted receipt or complete traces. `degraded`: delivering again (or no confirmed
 * delivery yet) but spans were lost earlier. `failing`: the most recent export failed and nothing has succeeded since.
 */
export type DeliveryState = 'disabled' | 'captured' | 'healthy' | 'degraded' | 'failing' | 'unknown';
/** Safe summary of the last export failure: HTTP status / error code / error class name only, never bodies or messages. */
export interface ExportErrorSummary { name: string | null; code: string | null; status: number | null; at: string }
/** turnId → opaque correlation id (HMAC of the session id) for the operator; the HMAC secret is never included. */
/** `traceId` is the exported root's OTel trace id (the hosted read API key); null when nothing was recorded. */
/** `turnRef` is the exported (hashed) turn id; `turnId` stays local to the operator diagnostics. */
export interface TurnCorrelation { turnId: string; turnRef: string; correlationId: string; sessionRef?: string; demoRef?: string; requestRef?: string; clientTurnRef?: string; sourceDemoRef?: string; traceId: string | null; status: 'ok' | 'failed' | null; outcome: string | null; version?: number; conversationVersion?: number; evidence?: EvidenceManifestSnapshot; completeness?: EvidenceComparison }
export interface TelemetryDiagnostics {
  /** Exact local observation IDs for independent hosted readback; never a delivery claim. */
  recentGuidance?: { traceId: string; outcome: GuidanceEvent['outcome']; demoRef: string; messageRef: string }[];
  mode: TelemetryMode;
  /** Export acknowledgement is separate from hosted receipt verification. */
  receiptState: 'unverified';
  evidenceFailures: number;
  captureEvictions: number;
  missingEvents: number;
  failedEvents: number;
  deliveryState: DeliveryState;
  droppedSteps: number; droppedAttributes: number; sdkFailures: number;
  /** Attribute values dropped because they looked like a credential or an email address (also in droppedAttributes). */
  redactedValues: number;
  /** Whether synthetic-fixture payloads may be attached (TelemetryOptions.syntheticPayloads). */
  syntheticPayloads: boolean;
  /** Export destination origin (neatlogs mode only; never a key). */
  endpoint: string | null;
  /** neatlogs: spans the SDK failed to export; captured: failed exporter calls (after bounded retries). */
  exportFailures: number;
  /** Alias of `droppedSpans` kept for existing readers. */
  droppedExports: number;
  /** Spans dropped before export (bounded queue full / masked away). */
  droppedSpans: number;
  /** Spans waiting in the batch queue; null when the SDK queue cannot be inspected (unavailable, not zero). */
  queued: number | null;
  /**
   * Tailor spans estimated exported (not verified received) (ended − failed − dropped, settled at each flush). The SDK's internal
   * `neatlogs.trace.complete` marker spans are excluded here and reported in `markerSpans`. `failed`/`dropped` come
   * from SDK counters that do not say which spans failed, so they may include markers: the estimate errs low.
   */
  exportedSpans: number;
  /** SDK-internal marker spans (`neatlogs.internal: true`) ended so far; never counted as Tailor spans. */
  markerSpans: number;
  lastExportError: ExportErrorSummary | null;
  lastSuccessfulExportAt: string | null;
  /** Last 20 turns, oldest first. */
  recentTurns: TurnCorrelation[];
}
/**
 * `flush()` outcome. An object is always truthy: callers MUST read `.ok`.
 * `ok` is false when any export failed or was dropped since the previous flush, when a failure is still unresolved
 * (an empty second flush after a rejected batch is NOT recovery), or when the flush timed out.
 * `ok` proves only an export acknowledgement. Hosted receipt/completeness always needs independent readback.
 */
export interface FlushResult { ok: boolean; exported: number; failed: number; state: DeliveryState; timedOut: boolean; receiptState?: 'unverified' }
/** Final `shutdown()` outcome (same shape as a flush). SIGKILL / a crash skips this entirely and loses the current batch. */
export type ShutdownResult = FlushResult;
export interface Telemetry {
  readonly mode: TelemetryMode;
  /** UI observations are separate interaction spans; they never rewrite a completed model turn. */
  guidanceEvent?(sessionId: string, demoId: string, event: GuidanceEvent): Promise<boolean>;
  forTurn(turnId: string, sessionId: string, options?: TurnOptions): RuntimeTurnTelemetry;
  flush(): Promise<FlushResult>;
  /** Bounded final flush + SDK shutdown; idempotent; never throws. */
  shutdown(): Promise<ShutdownResult>;
  /** captured mode only: spans recorded locally (bounded); empty otherwise. */
  captured(): CapturedSpan[];
  diagnostics(): TelemetryDiagnostics;
}

export interface GuidanceEvent {
  /** Server-owned approved synthetic fixture flag; never copied from buyer event bodies. */
  synthetic?: boolean;
  messageId: string; suggestionId: string; targetId: string; targetKey: string;
  version: number;
  outcome: 'selected' | 'shown' | 'failed' | 'dismissed';
  reason?: 'stale' | 'missing' | 'navigation' | 'loading' | 'dismissed' | 'render';
}

type RuntimeStep = TelemetryStep | 'context' | 'guard';
const STEP_KINDS: Record<RuntimeStep, TraceSpanKind> = {
  turn: 'WORKFLOW', context: 'CHAIN', guard: 'GUARDRAIL', load_context: 'CHAIN', retrieve_knowledge: 'RETRIEVER', model: 'CHAIN', validate: 'GUARDRAIL',
  save: 'TOOL', readback: 'TOOL', explain: 'CHAIN', repair: 'CHAIN', escalate: 'CHAIN', tool: 'TOOL',
};
// ---------------------------------------------------------------------------------------------------------------------
// Attribute allowlist (R2-03). Every string-valued key has its own validator: a closed enum, a strict id format, or a
// code-declared identifier (TelemetryVocabulary). Numbers/booleans pass only under count/measure/numeric/boolean keys.
// Free text, UUID-shaped values and undeclared ids are rejected and counted, whatever key they arrive under.
// ---------------------------------------------------------------------------------------------------------------------
const COUNT_KEY = /^[a-z][A-Za-z]{0,40}(Count|Calls|Records|Spans|Traces|Problems|Tokens|Chars|Bytes|Drops)$/;
/** Numeric-only keys (deadlines, reservations): `deadlineMs`, `reservationUsd`, `spentUsd`, ... Never strings. */
const MEASURE_KEY = /^[a-z][A-Za-z]{0,40}(Usd|Ms)$/;
const NUMERIC_KEYS = new Set([
  'version', 'expectedVersion', 'attemptedVersion', 'currentVersion', 'lastKnownVersion', 'conversationVersion',
  'versionBefore', 'versionAfter', 'attempt', 'repairs', 'httpStatus', 'contextSchemaVersion', 'evidenceOrdinal', 'policyAttempt', 'contextRecentTurnsKept', 'contextRecentTurnsDropped', 'contextPayloadsDropped', 'contextKnowledgeRecordsKept',
]);
const BOOL_KEYS = new Set(['escalated', 'retryable', 'permitted', 'mutates', 'costKnown', 'timeout', 'promptCaching', 'preventedDispatch', 'dispatchPrevented', 'estimated']);
const PROVIDER_ERROR_KINDS = new Set<ProviderErrorKind>([
  'auth', 'permission', 'billing', 'spend_cap', 'rate_limit', 'overloaded', 'timeout', 'network',
  'invalid_request', 'refusal', 'truncated', 'malformed', 'context_exceeded', 'unknown',
]);
const TURN_OUTCOMES = new Set(['answered', 'clarification', 'committed', 'rejected', 'save_failed', 'readback_uncertain', 'conflict', 'unsupported', 'refused', 'expired', 'provider_unavailable']);
const ENUMS = {
  provider: ['tailor-mock', 'anthropic'],
  mode: ['mock', 'live'],
  outcome: [...TURN_OUTCOMES],
  status: ['ok', 'failed', 'pending', 'applied', 'uncertain', 'question', 'note'],
  state: ['ok', 'rejected', 'uncertain', 'committed', 'conflict', 'save_failed', 'readback_uncertain', 'expired', 'unsupported'],
  reason: ['not_permitted', 'budget', 'no_time', 'malformed', 'ungrounded', 'error', ...PROVIDER_ERROR_KINDS],
  action: ['ask', 'tool', 'answer', 'unsupported', 'refuse'],
  plannerAction: ['ask','propose','explain','answer','unsupported','refuse','invalid'],
  proposalMode: ['new','edit'],
  step: Object.keys({ turn: 0, context: 0, guard: 0, load_context: 0, retrieve_knowledge: 0, model: 0, validate: 0, save: 0, readback: 0, explain: 0, repair: 0, escalate: 0, tool: 0 } satisfies Record<TelemetryStep, 0>),
  code: [
    'step_failed', 'SAVE_FAILED', 'SERVER_FAILURE', 'NOT_FOUND', 'TRACE_NOT_FOUND', 'SESSION_EXPIRED', 'SESSION_ENDED',
    'STALE_VERSION', 'CONVERSATION_CONFLICT', 'CONVERSATION_FULL', 'OPERATION_CONFLICT', 'IDEMPOTENCY_MISMATCH',
    'INVALID_CONVERSATION', 'INVALID_DATASET', 'INVALID_SESSION', 'INVALID_TURN', 'TURN_IN_FLIGHT', 'TURN_TEXT_INVALID',
    'ACTIVE_SCENARIO_UNKNOWN', 'BODY_TOO_LARGE',
  ],
  errorClass: ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AbortError', 'BudgetError', 'ProviderError', 'other'],
  stopReason: ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'],
  purpose: ['plan', 'repair', 'escalate', 'explain', 'guard'],
  policyOutcome: ['allow_product_question', 'allow_demo_action', 'clarify', 'redirect_off_topic', 'deny_instruction_override'],
  policyReason: ['product_question', 'demo_action', 'ambiguous', 'off_topic', 'instruction_override', 'guard_unavailable', 'invalid_classification'],
  guardOutcome: ['allow', 'clarify', 'reject'],
  guardStage: ['scope', 'intent', 'pre_dispatch'],
  settlement: ['not_sent', 'released', 'settled_reported', 'settled_unreconciled', 'pending'],
  evidencePhase: ['start', 'end'],
  evidenceStatus: ['ok', 'failed', 'cancelled', 'interrupted'],
  operation: ['turn', 'load_context', 'context', 'retrieve_knowledge', 'model', 'repair', 'escalate', 'validate', 'tool', 'save', 'readback', 'explain', 'guard', 'response'],
  estimationVersion: ['utf8-conservative-v1'],
  sourceComponent: ['system', 'context', 'conversation', 'repair', 'schema', 'framing'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  attemptResult: ['ok', 'invalid', 'error'],
  resultState: ['committed', 'rejected', 'conflict', 'save_failed', 'readback_uncertain', 'expired', 'unsupported', 'found', 'unavailable', 'refused'],
  detailState: ['ok', 'missing', 'failed', 'not_requested'],
  source: ['code', 'tool'],
} as const;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Declared identifiers must look like code-owned ids, never like a UUID, an email or a credential. */
const DECLARED_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ISSUE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const HASHED_TURN = /^t[0-9a-f]{16}$/;
const MAX_DECLARED = 256;
/** Tool names the model asked for that the adapter never declared are reported as this token. */
export const INVALID_TOOL_NAME = 'invalid_name';

interface Vocabulary { adapterIds: Set<string>; toolNames: Set<string>; recordIds: Set<string>; promptVersions: Set<string>; knowledgeVersions: Set<string>; codeVersions: Set<string>; adapterVersions: Set<string>; policyVersions: Set<string>; modelIds: Set<string>; contractVersions: Set<string> }
type SafeVocabulary = TelemetryVocabulary & { codeVersions?: readonly string[]; adapterVersions?: readonly string[]; policyVersions?: readonly string[]; modelIds?: readonly string[]; contractVersions?: readonly string[] };
const emptyVocabulary = (): Vocabulary => ({ adapterIds: new Set(), toolNames: new Set(), recordIds: new Set(), promptVersions: new Set(), knowledgeVersions: new Set(), codeVersions: new Set(), adapterVersions: new Set(), policyVersions: new Set(), modelIds: new Set(), contractVersions: new Set() });
function declareInto(into: Vocabulary, v: SafeVocabulary): void {
  const add = (set: Set<string>, ids: readonly string[] | undefined, shape: RegExp) => {
    for (const id of ids ?? []) {
      if (set.size >= MAX_DECLARED) return;
      if (typeof id === 'string' && shape.test(id) && !UUID_LIKE.test(id) && (!looksSensitive(id) || (set === into.codeVersions && /^[0-9a-f]{7,40}$/.test(id)))) set.add(id);
    }
  };
  add(into.adapterIds, v.adapterIds, DECLARED_ID); add(into.toolNames, v.toolNames, TOOL_ID); add(into.recordIds, v.recordIds, DECLARED_ID);
  add(into.promptVersions, v.promptVersions, DECLARED_ID); add(into.knowledgeVersions, v.knowledgeVersions, DECLARED_ID);
  for (const key of ['codeVersions', 'adapterVersions', 'policyVersions', 'modelIds', 'contractVersions'] as const) add(into[key], v[key], DECLARED_ID);
}
/** Builds a vocabulary from code-owned ids (tests and callers without a live core). */
export function telemetryVocabulary(v: SafeVocabulary): Vocabulary { const out = emptyVocabulary(); declareInto(out, v); return out; }

type Check = (v: unknown, vocab: Vocabulary) => boolean;
const str = (v: unknown): v is string => typeof v === 'string';
const inEnum = (allowed: readonly string[]): Check => v => str(v) && allowed.includes(v);
const format = (re: RegExp): Check => v => str(v) && re.test(v);
const declared = (pick: (vocab: Vocabulary) => Set<string>): Check => (v, vocab) => str(v) && pick(vocab).has(v);
/** Comma-joined list (no free text): at most `max` items, each passing `item`. */
const listOf = (item: Check, max: number): Check => (v, vocab) => {
  if (!str(v) || !v || v.length > 800) return false;
  const parts = v.split(',');
  return parts.length <= max && parts.every(p => item(p, vocab));
};

const DECISION_MAX = 240;
const PURPOSE_TOKEN = /^(?:plan|repair|escalate|explain)(?::(?:no_time|invalid|error|budget|ungrounded|[a-z_]{3,20}))?$/;
const FIXED_TOKENS = new Set(['ask', 'unsupported', 'error', 'readback ok', 'readback uncertain', 'repair:other_action', 'answer:redirect', 'answer:no_record', '...', ...TURN_OUTCOMES]);
const REFUSE_TOKEN = /^refuse:(?:injection|arbitrary_code|cross_session|real_mutation|off_topic|other)$/;
const TOOL_SUFFIX = /^ ?(?::(?:not_permitted|bad_args|budget|threw)| v\d{1,6}| found v\d{1,6}| (?:rejected|conflict|save_failed|readback_uncertain|expired|unsupported|failed|unavailable))$/;
/** One decision-trail token: a fixed token, a purpose token, or a declared tool id (or invalid_name) plus a fixed suffix. */
function decisionToken(t: string, vocab: Vocabulary): boolean {
  if (FIXED_TOKENS.has(t) || REFUSE_TOKEN.test(t) || /^answer:\d{1,2}_sources$/.test(t)) return true;
  const m = /^([A-Za-z][A-Za-z0-9_]{0,47})(.*)$/.exec(t);
  if (m && (vocab.toolNames.has(m[1]!) || m[1] === INVALID_TOOL_NAME) && TOOL_SUFFIX.test(m[2]!)) return true;
  if (PURPOSE_TOKEN.test(t)) {
    const suffix = t.split(':')[1];
    return suffix === undefined || ['no_time', 'invalid', 'error', 'budget', 'ungrounded'].includes(suffix) || PROVIDER_ERROR_KINDS.has(suffix as ProviderErrorKind);
  }
  return false;
}
/** Code-built decision trail: tokens joined by "→" (e.g. "plan→publishScenario v3→readback ok→committed"). */
const isDecision: Check = (v, vocab) => str(v) && v.length > 0 && v.length <= DECISION_MAX && v.split('→').every(t => decisionToken(t, vocab));

const VALIDATED: Record<string, Check> = {
  requestedModel: (v, vocab) => str(v) && (Object.hasOwn(MODEL_RATES, v) || vocab.modelIds.has(v)),
  resolvedModel: v => isResolvedAnthropicModel(v),
  systemPrefixSha256: format(/^[0-9a-f]{64}$/), schemaSha256: format(/^[0-9a-f]{64}$/),
  outputTokensIncludeThinking: v => v === true,
  reportedUsageAvailable: v => typeof v === 'boolean',
  ...Object.fromEntries(['reportedInputTokens', 'reportedOutputTokens', 'reportedCacheReadTokens', 'reportedCacheWriteTokens', 'reportedCacheWrite5mTokens', 'reportedCacheWrite1hTokens', 'reportedThinkingTokens']
    .map(key => [key, (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0])),
  guidanceOutcome: inEnum(['selected', 'shown', 'failed', 'dismissed']),
  guidanceReason: inEnum(['stale', 'missing', 'navigation', 'loading', 'dismissed', 'render', 'read_failed']),
  guidanceTarget: inEnum(['trace.overview', 'trace.slowest-span', 'trace.model-call', 'trace.output', 'evals.overview', 'alerts.overview']),
  messageRef: format(/^m[0-9a-f]{16}$/), suggestionRef: format(/^g[0-9a-f]{16}$/), targetRef: format(/^x[0-9a-f]{16}$/),
  turnId: format(HASHED_TURN),
  correlationId: format(/^[0-9a-f]{16}$/),
  traceId: format(/^[0-9a-f]{32}$/),
  requestId: format(/^req_[A-Za-z0-9]{3,64}$/),
  provider: inEnum(ENUMS.provider), providerMode: inEnum(ENUMS.mode), mode: inEnum(ENUMS.mode),
  model: (v, vocab) => str(v) && (Object.hasOwn(MODEL_RATES, v) || vocab.modelIds.has(v)),
  sessionRef: format(/^s[0-9a-f]{16}$/), sourceDemoRef: format(/^d[0-9a-f]{16}$/), demoRef: format(/^d[0-9a-f]{16}$/), requestRef: format(/^q[0-9a-f]{16}$/), clientTurnRef: format(/^c[0-9a-f]{16}$/), reservationRef: format(/^z[0-9a-f]{16}$/),
  codeVersion: declared(v => v.codeVersions), adapterVersion: declared(v => v.adapterVersions), policyVersion: declared(v => v.policyVersions), contractVersion: declared(v => v.contractVersions),
  policyOutcome: inEnum(ENUMS.policyOutcome), guardClassification: inEnum(ENUMS.policyOutcome), policyReason: inEnum(ENUMS.policyReason), guardReason: inEnum(ENUMS.policyReason), guardOutcome: inEnum(ENUMS.guardOutcome), guardStage: inEnum(ENUMS.guardStage), guardModel: (v, vocab) => str(v) && vocab.modelIds.has(v),
  settlement: inEnum(ENUMS.settlement), evidencePhase: inEnum(ENUMS.evidencePhase), evidenceStatus: inEnum(ENUMS.evidenceStatus), operation: inEnum(ENUMS.operation), evidenceKey: format(/^(?:turn|load_context|context|retrieve_knowledge|model|repair|escalate|validate|tool|save|readback|explain|guard|response):[1-9][0-9]{0,4}:(?:start|end)$/), estimationVersion: inEnum(ENUMS.estimationVersion), pricingVersion: inEnum(['tailor-rates-2026-10-12.1']), sourceComponent: inEnum(ENUMS.sourceComponent),
  outcome: inEnum(ENUMS.outcome), status: inEnum(ENUMS.status), state: inEnum(ENUMS.state), reason: inEnum(ENUMS.reason),
  plannerAction: inEnum(ENUMS.plannerAction), proposalMode: inEnum(ENUMS.proposalMode),
  action: inEnum(ENUMS.action), step: inEnum(ENUMS.step), code: inEnum(ENUMS.code), errorCode: inEnum(ENUMS.code),
  errorClass: inEnum(ENUMS.errorClass), stopReason: inEnum(ENUMS.stopReason),
  providerErrorKind: v => str(v) && PROVIDER_ERROR_KINDS.has(v as ProviderErrorKind),
  purpose: inEnum(ENUMS.purpose), effort: inEnum(ENUMS.effort), attemptResult: inEnum(ENUMS.attemptResult),
  resultState: inEnum(ENUMS.resultState), detailState: inEnum(ENUMS.detailState), source: inEnum(ENUMS.source),
  adapterId: declared(v => v.adapterIds), knowledgeVersion: declared(v => v.knowledgeVersions), promptVersion: declared(v => v.promptVersions),
  sourceIds: listOf(declared(v => v.recordIds), 12),
  issueCodes: listOf(format(ISSUE_CODE), 10),
  decision: isDecision,
};
const SYNTHETIC_MAX_CHARS = LIMITS.maxTurnTextChars;
/** Names service code already uses → the allowlisted key (kind → provider_error_kind, providerRequestId → request_id). */
const KEY_ALIAS: Record<string, string> = { kind: 'providerErrorKind', providerRequestId: 'requestId' };
/** Event names service code emits; anything else is recorded as `tailor.event`. */
const EVENT_NAMES = new Set([
  'planner_selected', 'guidance_selected', 'guidance_unavailable',
  'agent_error', 'commit', 'explain_unavailable', 'provider_error', 'provider_latency', 'provider_request_id', 'publish.result',
  'publish_threw', 'readback.result', 'evidence', 'policy', 'dispatch_prevented', 'context_trimmed', 'input_accounting', 'settlement', 'response', 'tool_refused', 'turn.recovered', 'turn.replayed', 'turn.result', 'validate.result', 'validation',
]);
export const isSafeTelemetryEventName = (name: unknown): name is string => typeof name === 'string' && (name === 'tailor.guidance' || name === 'tailor.event' || (name.startsWith('tailor.') && EVENT_NAMES.has(name.slice(7))));
/** SDK structural keys that may pass the export mask; anything carrying payload/content is denied. */
const SDK_KEY = /^(neatlogs\.|openinference\.span\.kind$|session\.id$|service\.name$|telemetry\.sdk\.|_span_name$)/;
const PAYLOAD_KEY = /(input|output|prompt|message|content|exception|retriever|parameters|end_?user|user\.|metadata|template|variables|document|query)/i;

// Credential / personal-data shapes. Any string value matching these is dropped (and counted) even under an allowed key.
const SECRET_LIKE = /sk-ant-|\b(?:sk|rk|pk)[-_](?:live|test|proj)[-_]|\bnl_[A-Za-z0-9_]{4,}|\bxox[abprs]-|\bgh[pousr]_[A-Za-z0-9]{16,}|github_pat_|\bAKIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.|-----BEGIN|\bbearer\s|api[_-]?key|passw(?:or)?d|secret|token=/i;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** Long unbroken mixed letter+digit runs (API keys, bearer tokens). Request ids and 16-hex ids stay below this. */
const highEntropy = (s: string) => (s.match(/[A-Za-z0-9]{32,}/g) ?? []).some(run => /\d/.test(run) && /[A-Za-z]/.test(run));
/** True when a value looks like a credential or an email address. */
export const looksSensitive = (v: unknown): boolean => typeof v === 'string' && (SECRET_LIKE.test(v) || EMAIL_LIKE.test(v) || highEntropy(v));

type AttrValue = string | number | boolean;
const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const finiteNonNegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validates one caller-supplied attribute (after aliasing). Strings only pass a per-key validator. */
function keyAccepts(k: string, v: unknown, vocab: Vocabulary): boolean {
  if (typeof v === 'string' && UUID_LIKE.test(v)) return false;
  if (Object.hasOwn(VALIDATED, k)) return VALIDATED[k]!(v, vocab);
  if (BOOL_KEYS.has(k)) return typeof v === 'boolean';
  if (NUMERIC_KEYS.has(k) || COUNT_KEY.test(k) || MEASURE_KEY.test(k)) return finiteNonNegative(v);
  return false;
}

/**
 * Allowlist for caller-supplied attributes (see the block comment above). `toolName` is resolved against declared
 * tool ids: anything else is exported as `invalid_name` (and counted). `evidenceRefs` (comma-joined product evidence
 * ids) is exported only as keyed hashes via `hashRef`, because product ids can embed session identifiers; without
 * `hashRef` it is dropped. Credential/email-like values are always dropped and counted in `redacted` (and `dropped`).
 */
export function cleanAttributes(attrs: Record<string, unknown> | undefined, hashRef?: (id: string) => string, vocab: Vocabulary = emptyVocabulary()): { clean: Record<string, AttrValue>; dropped: number; redacted: number } {
  const clean: Record<string, AttrValue> = {};
  let dropped = 0;
  let redacted = 0;
  for (const [rawKey, v] of Object.entries(attrs ?? {})) {
    const k = KEY_ALIAS[rawKey] ?? rawKey;
    if (k === 'evidenceRefs') {
      const parts = typeof v === 'string' && v ? v.split(',') : [];
      if (hashRef && parts.length > 0 && parts.length <= 8 && parts.every(p => p.length > 0 && p.length <= 200)) clean['tailor.evidence_refs'] = parts.map(hashRef).join(',');
      else dropped++;
      continue;
    }
    // A 32-hex OTel trace id is a long mixed run by construction; its strict format is the whole check.
    const strictTraceId = k === 'traceId' && VALIDATED.traceId!(v, vocab);
    const strictCodeVersion = k === 'codeVersion' && VALIDATED.codeVersion!(v, vocab) && typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v);
    const strictFingerprint = (k === 'systemPrefixSha256' || k === 'schemaSha256') && VALIDATED[k]!(v, vocab);
    if (!strictTraceId && !strictCodeVersion && !strictFingerprint && looksSensitive(v)) { dropped++; redacted++; continue; }
    if (k === 'toolName') {
      const known = typeof v === 'string' && (vocab.toolNames.has(v) || v === INVALID_TOOL_NAME);
      clean['tailor.tool_name'] = known ? v : INVALID_TOOL_NAME;
      if (!known) dropped++;
      continue;
    }
    if (keyAccepts(k, v, vocab)) clean[`tailor.${snake(k)}`] = v as AttrValue; else dropped++;
  }
  return { clean, dropped, redacted };
}

/** Per exported key: the same validators as `cleanAttributes`, plus the keys the telemetry layer sets itself. */
function exportValidators(): Record<string, Check> {
  const out: Record<string, Check> = {};
  for (const [k, check] of Object.entries(VALIDATED)) out[`tailor.${snake(k)}`] = check;
  out['tailor.tool_name'] = (v, vocab) => str(v) && (vocab.toolNames.has(v) || v === INVALID_TOOL_NAME);
  out['tailor.evidence_refs'] = listOf(format(/^r[0-9a-f]{10}$/), 8);
  out['tailor.synthetic_input'] = v => str(v) && v.length <= SYNTHETIC_MAX_CHARS;
  out['tailor.synthetic_output'] = v => str(v) && v.length <= SYNTHETIC_MAX_CHARS;
  return out;
}
const EXPORT_VALIDATORS = exportValidators();
function exportable(key: string, value: unknown, vocab: Vocabulary): boolean {
  const fingerprint = (key === 'tailor.system_prefix_sha256' || key === 'tailor.schema_sha256') && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (looksSensitive(value) && !fingerprint && !(key === 'tailor.code_version' && typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value) && vocab.codeVersions.has(value))) return false;
  if (key.startsWith('tailor.')) {
    if (typeof value === 'string') {
      const check = EXPORT_VALIDATORS[key];
      if (!check || (UUID_LIKE.test(value) && !key.startsWith('tailor.synthetic_'))) return false;
      return check(value, vocab);
    }
    if (key === 'tailor.synthetic_input_truncated' || key === 'tailor.synthetic_output_truncated') return typeof value === 'boolean';
    if (key === 'tailor.usage.available' || key === 'tailor.model_call' || key === 'tailor.synthetic') return typeof value === 'boolean';
    if (/^tailor\.usage\.(?:input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|thinking_tokens)$/.test(key)) return finiteNonNegative(value);
    const rawKey = key.slice('tailor.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    return keyAccepts(rawKey, value, vocab);
  }
  if (key === 'neatlogs.llm.model_name') return str(value) && (Object.hasOwn(MODEL_RATES, value) || vocab.modelIds.has(value));
  if (key === 'neatlogs.llm.cost_usd') return finiteNonNegative(value);
  if (key === 'neatlogs.llm.provider') return str(value) && ENUMS.provider.includes(value as 'anthropic' | 'tailor-mock');
  if (/^neatlogs\.llm\.token_count\.(?:prompt|completion|total|cache_read|cache_write|reasoning)$/.test(key)) return finiteNonNegative(value);
  if (key === 'neatlogs.end_user.id') return typeof value === 'string' && /^u[0-9a-f]{16}$/.test(value);
  if (!SDK_KEY.test(key) || PAYLOAD_KEY.test(key)) return false;
  return (typeof value === 'string' && value.length <= 200 && !/\s{2,}|[<>`]/.test(value)) || typeof value === 'number' || typeof value === 'boolean';
}

/** Summaries repeat only already-observed safe fields; absent planner output stays unavailable. */
export function summariseObservedDiagnostics(records: Record<string, unknown>[]): Record<string, unknown> {
  const attrs = records.map(record => record.attributes as Record<string, unknown>);
  const events = records.flatMap(record => Array.isArray(record.events) ? record.events as { name: string; attributes: Record<string, unknown> }[] : []);
  const selected = new Set(attrs.flatMap(value => typeof value['tailor.source_ids'] === 'string' ? value['tailor.source_ids'].split(',') : []));
  const fields = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]));
  return {
    // Numbers and closed ids only. These are observed attempts, not totals; absent counters stay absent.
    providerAttempts: attrs.filter(value => value['tailor.requested_model'] !== undefined).slice(0, 4).map(value => fields(value, [
      'tailor.step', 'tailor.purpose', 'tailor.effort', 'tailor.attempt', 'tailor.requested_model', 'tailor.resolved_model', 'tailor.stop_reason',
      'tailor.request_id', 'tailor.attempt_result', 'tailor.latency_ms', 'tailor.cost_usd', 'tailor.settlement', 'tailor.pricing_version',
      'tailor.reported_usage_available', 'tailor.output_tokens_include_thinking', 'tailor.reported_input_tokens', 'tailor.reported_output_tokens',
      'tailor.reported_cache_read_tokens', 'tailor.reported_cache_write_tokens', 'tailor.reported_cache_write5m_tokens', 'tailor.reported_cache_write1h_tokens', 'tailor.reported_thinking_tokens',
      'tailor.message_count', 'tailor.system_bytes', 'tailor.conversation_bytes', 'tailor.schema_bytes', 'tailor.total_input_bytes', 'tailor.input_estimated_tokens',
      'tailor.framing_estimated_tokens', 'tailor.estimation_version', 'tailor.system_prefix_sha256', 'tailor.schema_sha256',
    ])),
    capabilities: { available: attrs.some(value => value['tailor.record_count'] !== undefined || value['tailor.source_ids'] !== undefined), sourceIds: [...selected].slice(0,12) },
    context: attrs.map(value => fields(value, ['tailor.context_bytes','tailor.context_chars','tailor.context_budget_chars','tailor.context_recent_turns_kept','tailor.context_recent_turns_dropped','tailor.context_payloads_dropped','tailor.context_knowledge_records_kept'])).filter(value => Object.keys(value).length).slice(0,8),
    guards: attrs.map(value => fields(value, ['tailor.guard_stage','tailor.guard_classification','tailor.guard_reason','tailor.guard_outcome','tailor.policy_outcome','tailor.policy_reason'])).filter(value => Object.keys(value).length).slice(0,8),
    action: { plannerType: events.findLast(event => event.name === 'tailor.planner_selected')?.attributes['tailor.planner_action'] ?? attrs.find(value => value['tailor.action'] !== undefined)?.['tailor.action'] ?? null,
      structuredSelections: events.filter(event => event.name === 'tailor.planner_selected').slice(0,8).map(event => event.attributes),
      decision: attrs.find(value => value['tailor.decision'] !== undefined)?.['tailor.decision'] ?? null,
      toolNames: [...new Set(attrs.flatMap(value => typeof value['tailor.tool_name'] === 'string' ? [value['tailor.tool_name']] : []))].slice(0,8),
      suggestionCount: events.findLast(event => event.name === 'tailor.guidance_selected')?.attributes['tailor.suggestion_count'] ?? null,
      guidanceTargetIds: [...new Set(events.flatMap(event => typeof event.attributes['tailor.guidance_target'] === 'string' ? [event.attributes['tailor.guidance_target']] : []))].slice(0,3) },
    results: attrs.map(value => fields(value, ['tailor.step','tailor.status','tailor.result_state','tailor.state','tailor.version','tailor.version_before','tailor.version_after','tailor.detail_state','tailor.problem_count'])).filter(value => value['tailor.result_state'] !== undefined || value['tailor.state'] !== undefined || value['tailor.problem_count'] !== undefined).slice(0,12),
    resultEvents: events.filter(event => ['validation','validate.result','publish.result','readback.result'].includes(event.name.slice(7))).slice(0,12),
  };
}

/** Native panels format JSON objects; labelled plain text preserves the diagnostic JSON line. */
export function parseNativeDiagnosticEnvelope(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length > 24_000) return null;
  const lines = value.split('\n');
  const schema = { TAILOR_NATIVE_INPUT_V1: 'tailor-native-input-v1', TAILOR_NATIVE_OUTPUT_V1: 'tailor-native-output-v1', TAILOR_GUIDANCE_DIAGNOSTICS_V1: 'tailor-guidance-diagnostics-v1' }[lines[0] ?? ''];
  if (!schema || lines.filter(line => line.startsWith('ORIGINAL_TEXT_JSON:')).length !== 1 || lines.filter(line => line.startsWith('DIAGNOSTICS_JSON:')).length > 1) return null;
  try {
    const text = JSON.parse(lines.find(line => line.startsWith('ORIGINAL_TEXT_JSON:'))!.slice('ORIGINAL_TEXT_JSON:'.length));
    const diagnosticsLine = lines.find(line => line.startsWith('DIAGNOSTICS_JSON:'));
    const diagnostics = diagnosticsLine ? JSON.parse(diagnosticsLine.slice('DIAGNOSTICS_JSON:'.length)) : undefined;
    return { schema, text, ...(diagnostics ? { diagnostics } : {}) };
  } catch { return null; }
}
function nativeDiagnosticText(envelope: { schema: string; text: unknown; diagnostics?: unknown }): string {
  const schema = { 'tailor-native-input-v1': 'TAILOR_NATIVE_INPUT_V1', 'tailor-native-output-v1': 'TAILOR_NATIVE_OUTPUT_V1', 'tailor-guidance-diagnostics-v1': 'TAILOR_GUIDANCE_DIAGNOSTICS_V1' }[envelope.schema];
  return `${schema}\nORIGINAL_TEXT_JSON:${JSON.stringify(envelope.text)}${envelope.diagnostics ? `\nDIAGNOSTICS_JSON:${JSON.stringify(envelope.diagnostics)}` : ''}`;
}

/** Defence-in-depth export mask: only allowlisted attributes and Tailor events survive; status text is dropped. */
export function createSpanMask(vocab: Vocabulary, options: { hostedFields?: boolean; syntheticPayloads?: boolean } = {}): MaskFunction {
  const filterAttrs = (attrs: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k, v]) => exportable(k, v, vocab)));
  const observed = new Map<string, { steps: Record<string, unknown>[]; truncated: boolean }>();
  return (data) => {
    const events = Array.isArray(data.events) ? data.events : [];
    const attributes = filterAttrs(data.attributes);
    const safeEvents = events.filter((e: { name?: unknown }) => typeof e?.name === 'string' && e.name.startsWith('tailor.')).map((e: { name: string; attributes?: Record<string, unknown> }) => ({ ...e, attributes: filterAttrs(e.attributes) }));
    if (options.hostedFields) {
      // The hosted read API exposes metadata rather than raw OTel attrs/events. Construct this
      // envelope ourselves: inbound metadata is always denied, and payload fields never enter it.
      const metadataAttributes = Object.fromEntries(Object.entries(attributes).filter(([k]) => k.startsWith('tailor.') && !k.startsWith('tailor.synthetic_')));
      const metadataEvents = safeEvents.filter((e: { name: string }) => isSafeTelemetryEventName(e.name))
        .slice(0, LIMITS.telemetryQueueMax).map((e: { name: string; attributes: Record<string, unknown> }) => ({ name: e.name,
          attributes: Object.fromEntries(Object.entries(e.attributes).filter(([k]) => k.startsWith('tailor.') && !k.startsWith('tailor.synthetic_'))) }));
      const sdk: Record<string, unknown> = {};
      const session = attributes['neatlogs.session.id'];
      if (typeof session === 'string' && /^[0-9a-f]{16}$/.test(session)) sdk['neatlogs.session.id'] = session;
      for (const key of ['neatlogs.span.kind', 'openinference.span.kind']) {
        const kind = attributes[key];
        if (typeof kind === 'string' && /^(?:workflow|chain|guardrail|tool|retriever|llm|agent|Neatlogs.INTERNAL)$/i.test(kind)) sdk[key] = kind;
      }
      const synthetic: Record<string, string> = {};
      if (options.syntheticPayloads && attributes['tailor.synthetic'] === true && attributes['tailor.step'] === 'turn') {
        for (const [field, key] of [['input', 'tailor.synthetic_input'], ['output', 'tailor.synthetic_output']]) {
          const value = attributes[key!];
          if (typeof value === 'string' && value.length <= SYNTHETIC_MAX_CHARS && !looksSensitive(value)) {
            synthetic[field!] = value;
          }
        }
      }

      // Preserve the original Tailor evidence and add the pinned SDK's documented usage keys.
      const model = attributes['tailor.model'];
      if (typeof model === 'string' && exportable('neatlogs.llm.model_name', model, vocab)) attributes['neatlogs.llm.model_name'] = model;
      const provider = attributes['tailor.provider'];
      if (typeof provider === 'string' && exportable('neatlogs.llm.provider', provider, vocab)) attributes['neatlogs.llm.provider'] = provider;
      const mappings = { input_tokens: 'prompt', output_tokens: 'completion', cache_read_input_tokens: 'cache_read', cache_creation_input_tokens: 'cache_write', thinking_tokens: 'reasoning' };
      for (const [source, target] of Object.entries(mappings)) {
        const value = attributes[`tailor.usage.${source}`];
        if (finiteNonNegative(value)) attributes[`neatlogs.llm.token_count.${target}`] = value;
      }
      const paidStep = attributes['tailor.step'];
      if (typeof paidStep === 'string' && ['guard', 'model', 'repair', 'escalate'].includes(paidStep)
        && attributes['tailor.usage.available'] === true && attributes['neatlogs.llm.model_name'] !== undefined)
        attributes['neatlogs.span.kind'] = 'llm';
      if (attributes['neatlogs.span.kind'] === 'llm' && attributes['tailor.cost_known'] === true && finiteNonNegative(attributes['tailor.cost_usd'])) {
        attributes['neatlogs.llm.cost_usd'] = attributes['tailor.cost_usd'];
        // This is the provider-usage/rate estimate already recorded locally, never authoritative billing.
        attributes['tailor.estimated'] = true;
        metadataAttributes['tailor.estimated'] = true;
      }
      const input = attributes['tailor.usage.input_tokens']; const output = attributes['tailor.usage.output_tokens'];
      if (finiteNonNegative(input) && finiteNonNegative(output)) attributes['neatlogs.llm.token_count.total'] = (input as number) + (output as number);
      if (attributes['neatlogs.span.kind'] === 'llm') sdk['neatlogs.span.kind'] = 'llm';
      if (Object.keys(metadataAttributes).length || metadataEvents.length) attributes['neatlogs.metadata'] = JSON.stringify({ tailor: { attributes: metadataAttributes, events: metadataEvents }, ...(Object.keys(sdk).length ? { sdk } : {}), ...(Object.keys(synthetic).length ? { synthetic } : {}) });
      const turnRef = attributes['tailor.turn_id'];
      const validSpanId = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : null;
      const record = { spanId: validSpanId(data.span_id ?? data.spanId), parentSpanId: validSpanId(data.parent_span_id ?? data.parentSpanId),
        step: attributes['tailor.step'] ?? null, attributes: metadataAttributes,
        events: metadataEvents.filter(event => event.name !== 'tailor.evidence'),
        receipts: metadataEvents.filter(event => event.name === 'tailor.evidence').map(event => [event.attributes['tailor.evidence_key'], event.attributes['tailor.evidence_status']]), sdk };
      if (typeof turnRef === 'string' && HASHED_TURN.test(turnRef) && attributes['tailor.step'] !== 'turn') {
        if (!observed.has(turnRef)) { if (observed.size >= 20) observed.delete(observed.keys().next().value!); observed.set(turnRef, { steps: [], truncated: false }); }
        const group = observed.get(turnRef)!;
        if (group.steps.length < 100) group.steps.push(record); else group.truncated = true;
      }
      const approvedRoot = options.syntheticPayloads && attributes['tailor.synthetic'] === true && attributes['tailor.step'] === 'turn';
      const approvedGuidance = options.syntheticPayloads && attributes['tailor.synthetic'] === true && data.name === 'tailor.guidance';
      if (approvedRoot || approvedGuidance) {
        const group = typeof turnRef === 'string' ? observed.get(turnRef) : undefined;
        const diagnostics = { schema: 'tailor-observed-diagnostics-v1', traceId: typeof (data.trace_id ?? data.traceId) === 'string' && /^[0-9a-f]{32}$/.test(data.trace_id ?? data.traceId) ? (data.trace_id ?? data.traceId) : null,
          root: record, steps: (group?.steps ?? []).map(step => ({ ...step,
            attributes: Object.fromEntries(Object.entries(step.attributes as Record<string, unknown>).filter(([key,value]) => metadataAttributes[key] !== value)),
            sdk: Object.fromEntries(Object.entries(step.sdk as Record<string, unknown>).filter(([key,value]) => sdk[key] !== value)),
          })), truncated: group?.truncated ?? false, summaries: {} as Record<string, unknown> };
        diagnostics.summaries = summariseObservedDiagnostics([diagnostics.root, ...diagnostics.steps]);
        const outputEnvelope = { schema: approvedRoot ? 'tailor-native-output-v1' : 'tailor-guidance-diagnostics-v1',
          text: approvedRoot && synthetic.output !== undefined ? { value: synthetic.output, truncated: attributes['tailor.synthetic_output_truncated'] === true } : null, diagnostics };
        while (nativeDiagnosticText(outputEnvelope).length > 24_000 && diagnostics.steps.length) { diagnostics.steps.pop(); diagnostics.truncated = true; diagnostics.summaries = summariseObservedDiagnostics([diagnostics.root, ...diagnostics.steps]); }
        while (nativeDiagnosticText(outputEnvelope).length > 24_000 && diagnostics.root.events.length) { diagnostics.root.events.pop(); diagnostics.truncated = true; }
        if (nativeDiagnosticText(outputEnvelope).length <= 24_000) {
          const value = nativeDiagnosticText(outputEnvelope);
          for (const key of ['output.value','neatlogs.output.value', 'neatlogs.workflow.output']) attributes[key] = value;
        }
        if (approvedRoot && synthetic.input !== undefined) {
          const value = nativeDiagnosticText({ schema: 'tailor-native-input-v1', text: { value: synthetic.input, truncated: attributes['tailor.synthetic_input_truncated'] === true } });
          for (const key of ['input.value','neatlogs.input.value','neatlogs.workflow.input']) attributes[key] = value;
        }
      }
      if (typeof turnRef === 'string' && attributes['tailor.step'] === 'turn') observed.delete(turnRef);
      // SDK namespace mapping documents `metadata` as the source alias for neatlogs.metadata.
      // Emit only this generated whitelist envelope; inbound metadata remains denied.
      if (typeof attributes['neatlogs.metadata'] === 'string') attributes.metadata = attributes['neatlogs.metadata'];
    }
    return {
      ...data, attributes, events: safeEvents,
      status: data.status ? { ...data.status, description: null } : data.status,
    };
  };
}
/** Mask with no declared vocabulary (declared ids are dropped); instances use their own `createSpanMask`. */
export const maskSpanData: MaskFunction = createSpanMask(emptyVocabulary());

export const correlationIdFor = (secret: string, sessionId: string) => createHmac('sha256', secret).update(sessionId).digest('hex').slice(0, 16);

/** Error passed through the SDK in place of the real one, so recorded exceptions carry only a safe code. */
class StepFailed extends Error { constructor(code: string) { super(code); this.name = 'StepFailed'; } }
const errorCodeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (ENUMS.code as readonly string[]).includes(code) ? code : 'step_failed';
};

type ExportCallback = Parameters<SpanExporter['export']>[1];
/** Bounded pending queue + bounded retries around any exporter; exporter throws never escape. */
class BoundedRetryExporter implements SpanExporter {
  inner: SpanExporter; pending = 0; failures = 0; dropped = 0; lastError: ExportErrorSummary | null = null;
  constructor(inner: SpanExporter) { this.inner = inner; }
  export(spans: ReadableSpan[], done: ExportCallback): void {
    if (this.pending + spans.length > LIMITS.telemetryQueueMax) { this.dropped += spans.length; done({ code: 1 }); return; }
    this.pending += spans.length;
    const finish = (code: 0 | 1, error?: Error) => {
      this.pending -= spans.length;
      if (code !== 0) { this.failures++; this.lastError = summarizeError(error); }
      try { done(error ? { code, error } : { code }); } catch { /* processor callback must not throw back */ }
    };
    const attempt = (n: number) => {
      try {
        this.inner.export(spans, result => {
          if (result.code === 0) finish(0);
          else if (n < LIMITS.telemetryExportRetries) attempt(n + 1);
          else finish(1, result.error);
        });
      } catch (e) {
        if (n < LIMITS.telemetryExportRetries) attempt(n + 1); else finish(1, e instanceof Error ? e : new Error('export failed'));
      }
    };
    attempt(0);
  }
  async shutdown() { try { await this.inner.shutdown(); } catch { /* ignore */ } }
  async forceFlush() { try { await this.inner.forceFlush?.(); } catch { /* ignore */ } }
}

/** Keeps the last N finished spans locally (captured mode) so tests can assert with zero network. */
class CaptureProcessor implements SpanProcessor {
  evictions = 0;
  spans: CapturedSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    try {
      const ctx = span.spanContext();
      this.spans.push({
        name: span.name, traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: span.parentSpanId ?? null,
        attributes: { ...span.attributes },
        events: span.events.map(e => ({ name: e.name, attributes: { ...(e.attributes ?? {}) } })),
        status: { code: span.status.code, ...(span.status.message ? { message: span.status.message } : {}) },
      });
      if (this.spans.length > LIMITS.telemetryQueueMax) { this.spans.shift(); this.evictions++; }
    } catch { /* never throw from a processor */ }
  }
  async forceFlush() {}
  async shutdown() {}
}

/** Accepts and discards every span: captured mode keeps spans only in the bounded CaptureProcessor. */
const successExporter: SpanExporter = {
  export: (_spans, done) => done({ code: 0 }),
  shutdown: async () => {},
  forceFlush: async () => {},
};

/** Counts Tailor spans that end in this provider (used to estimate `exported`); SDK marker spans are counted apart. */
class SpanCounter implements SpanProcessor {
  ended = 0;
  markers = 0;
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    if (span.attributes?.['neatlogs.internal'] === true) this.markers++; else this.ended++;
  }
  async forceFlush() {}
  async shutdown() {}
}

const RECENT_TURNS = 20;
/** Bounded turnId → correlationId log for the operator (the HMAC secret and raw session id are never stored). */
class TurnLog {
  private entries: TurnCorrelation[] = [];
  track(turnId: string, turnRef: string, correlationId: string, requestRef?: string): TurnCorrelation {
    const safe = /^[A-Za-z0-9_.:\/-]{1,64}$/.test(turnId) ? turnId : 'invalid';
    const existing = this.entries.find(e => e.turnId === safe && e.correlationId === correlationId && e.requestRef === requestRef);
    if (existing) return existing;
    const entry: TurnCorrelation = { turnId: safe, turnRef, correlationId, ...(requestRef ? { requestRef } : {}), traceId: null, status: null, outcome: null };
    this.entries.push(entry);
    if (this.entries.length > RECENT_TURNS) this.entries.shift();
    return entry;
  }
  snapshot(): TurnCorrelation[] { return this.entries.map(e => structuredClone(e)); }
}

/** Reduces any thrown/reported export error to class name + code/status. Messages and bodies are never read. */
function summarizeError(error: unknown): ExportErrorSummary {
  // The provider rejects with an array of per-processor errors; AggregateError carries `.errors`. Use the first entry.
  const first = Array.isArray(error) ? error[0] : Array.isArray((error as { errors?: unknown } | null)?.errors) ? (error as { errors: unknown[] }).errors[0] : error;
  const e = (first ?? {}) as { name?: unknown; code?: unknown; cause?: unknown };
  const c = e.code ?? (e.cause as { code?: unknown } | null | undefined)?.code;
  return {
    name: typeof e.name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : null,
    code: typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : null,
    status: typeof c === 'number' && Number.isInteger(c) && c >= 100 && c <= 599 ? c : null,
    at: new Date().toISOString(),
  };
}

type Settled = 'ok' | 'failed' | 'timeout';
/** Awaits `work` for at most `ms`; never throws, never leaves the timer running. */
async function bounded(work: Promise<unknown>, ms: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => 'ok' as const, () => 'failed' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, ms)); }),
    ]);
  } finally { clearTimeout(timer); }
}

const noopTurn = (turnId: string, turnRef: string, correlationId: string): RuntimeTurnTelemetry => ({
  turnId, turnRef, correlationId, sessionRef: `s${correlationId}`, demoRef: '', requestRef: '', clientTurnRef: '', evidence: createEvidenceObserver(),
  declare: () => {},
  step: (_name, _attrs, fn) => fn(),
  event: () => {},
  recordUsage: () => {},
  annotate: () => {},
  attachSynthetic: () => false,
});
const DEFAULT_ENDPOINT = 'https://ingest.neatlogs.com';
const originOf = (url: string | undefined): string | null => { try { return new URL(url || DEFAULT_ENDPOINT).origin; } catch { return null; } };
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

let active: Telemetry | null = null;

export async function createTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const { mode, secret } = options;
  if (typeof secret !== 'string' || !secret) throw new Error('Telemetry needs a non-empty server-side secret.');
  const log = options.log ?? ((line: string) => { try { console.error(line); } catch { /* stderr closed */ } });
  const turns = new TurnLog();
  const safeRef = (kind: string, id: string) => `${kind}${createHmac('sha256', secret).update(`${kind}:${id}`).digest('hex').slice(0, 16)}`;
  const turnRefFor = (turnId: string) => `t${createHmac('sha256', secret).update(`turn:${turnId}`).digest('hex').slice(0, 16)}`;
  const vocab = emptyVocabulary();
  if (mode === 'disabled') {
    const quiet: FlushResult = { ok: true, exported: 0, failed: 0, state: 'disabled', timedOut: false };
    return {
      mode,
      forTurn: (turnId: string, sessionId: string, opts: TurnOptions = {}) => {
        const cid = correlationIdFor(secret, sessionId); const ref = turnRefFor(turnId); const requestRef = safeRef('q', opts.requestId ?? turnId); const summary = turns.track(turnId, ref, cid, requestRef);
        const evidence = createEvidenceObserver({ ...(opts.manifest ? { manifest: opts.manifest } : {}), onChange(snapshot) { summary.evidence = snapshot; summary.completeness = compareEvidence(snapshot); try { opts.onEvidence?.(snapshot); } catch { /* disabled telemetry cannot fail a turn */ } } });
        summary.evidence = evidence.snapshot(); summary.completeness = compareEvidence(summary.evidence);
        return { ...noopTurn(turnId, ref, cid), sessionRef: `s${cid}`, demoRef: safeRef('d', opts.demoId ?? sessionId), requestRef, clientTurnRef: safeRef('c', opts.clientTurnId ?? turnId), evidence };
      },
      flush: async () => ({ ...quiet }), shutdown: async () => ({ ...quiet }), captured: () => [],
      diagnostics: () => ({
        mode, receiptState: 'unverified', recentGuidance: [], evidenceFailures: 0, captureEvictions: 0, missingEvents: 0, failedEvents: 0, deliveryState: 'disabled', droppedSteps: 0, droppedAttributes: 0, sdkFailures: 0, redactedValues: 0,
        syntheticPayloads: false, endpoint: null, exportFailures: 0, droppedExports: 0,
        droppedSpans: 0, queued: 0, exportedSpans: 0, markerSpans: 0, lastExportError: null, lastSuccessfulExportAt: null, recentTurns: turns.snapshot(),
      }),
    };
  }
  if (mode !== 'captured' && mode !== 'neatlogs') throw new Error('Unknown telemetry mode.');
  if (mode === 'neatlogs' && !options.apiKey) throw new Error('Telemetry mode "neatlogs" needs an explicit apiKey from the composition root.');
  // The SDK keeps one module-level pipeline per process; a new instance replaces the previous one.
  if (active) await active.shutdown();

  const provider = new BasicTracerProvider();
  await init({
    disableExport: mode !== 'neatlogs',
    tracerProvider: provider,
    mask: createSpanMask(vocab, { hostedFields: mode === 'neatlogs', syntheticPayloads: options.syntheticPayloads === true }),
    workflowName: 'tailor-agent',
    tags: ['tailor', 'runtime'],
    registerShutdownHandlers: false,
    ...(mode === 'neatlogs' ? {
      apiKey: options.apiKey,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.flushIntervalSeconds !== undefined ? { flushInterval: options.flushIntervalSeconds } : {}),
    } : {}),
  });
  // Added after init so they observe spans after the SDK processor has normalised attributes.
  const counter = new SpanCounter();
  provider.addSpanProcessor(counter);
  const capture = new CaptureProcessor();
  let exporter: BoundedRetryExporter | null = null;
  if (mode === 'captured') {
    exporter = new BoundedRetryExporter(options.exporter ?? successExporter);
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.addSpanProcessor(capture);
  }

  const recentGuidance: NonNullable<TelemetryDiagnostics['recentGuidance']> = [];
  const diag = { evidenceFailures: 0, droppedSteps: 0, droppedAttributes: 0, sdkFailures: 0, redactedValues: 0 };
  const syntheticPayloads = options.syntheticPayloads === true;
  const endpoint = mode === 'neatlogs' ? originOf(options.endpoint ?? process.env.NEATLOGS_ENDPOINT?.trim()) : null;
  /** Keyed, truncated hash for product evidence ids (they may embed session ids): stable per id, not reversible. */
  const hashRef = (id: string) => `r${createHmac('sha256', secret).update(`evidence:${id}`).digest('hex').slice(0, 10)}`;
  const context = new AsyncLocalStorage<{ turnId: string; span: OtelSpan }>();
  const roots = new Map<string, OtelSpan>();
  let pending = 0;
  const guard = (fn: () => void) => { try { fn(); } catch { diag.sdkFailures++; } };
  const targetSpan = (turnId: string) => {
    const store = context.getStore();
    return store && store.turnId === turnId ? store.span : roots.get(turnId);
  };

  // ---- delivery accounting (neatlogs: SDK counters folded in; captured: BoundedRetryExporter) ----
  const sdkBase = (() => { const s = getDeliveryDiagnostics(); return { failed: s.spanExportFailures, dropped: s.spanQueueDrops + s.maskedSpanDrops }; })();
  let frozen: { failed: number; dropped: number; queued: number | null } | null = null;
  const queuedNow = (): number | null => {
    if (frozen) return frozen.queued;
    if (exporter) return exporter.pending;
    const processors = (provider as unknown as { _registeredSpanProcessors?: unknown })._registeredSpanProcessors;
    let total = 0; let seen = false;
    if (Array.isArray(processors)) {
      for (const p of processors) {
        const q = (p as { _finishedSpans?: unknown } | null)?._finishedSpans;
        if (Array.isArray(q)) { total += q.length; seen = true; }
      }
    }
    return seen ? total : null;
  };
  const totals = () => {
    if (frozen) return frozen;
    if (exporter) return { failed: exporter.failures, dropped: exporter.dropped };
    const s = getDeliveryDiagnostics();
    return { failed: s.spanExportFailures - sdkBase.failed, dropped: s.spanQueueDrops + s.maskedSpanDrops - sdkBase.dropped };
  };
  let failedAtSuccess = 0;       // failure counter when delivery was last confirmed; failed > this means "failing"
  let flushedFailed = 0;         // counters as of the previous flush (per-flush deltas)
  let flushedDropped = 0;
  let settledExported = 0;
  let lastError: ExportErrorSummary | null = null;
  let lastSuccessAt: string | null = null;
  let burstLogged = false;
  let closed = false;

  const stateNow = (): DeliveryState => {
    if (mode === 'captured') return 'captured';
    const t = totals();
    if (t.failed > failedAtSuccess) return 'failing';
    if (t.failed > 0 || t.dropped > 0) return 'degraded';
    return lastSuccessAt ? 'healthy' : 'unknown';
  };
  /** One bounded line per failure burst; a confirmed delivery ends the burst. `force`: an export error was just observed. */
  const logBurst = (force: boolean) => {
    if (mode !== 'neatlogs' || burstLogged) return;
    const t = totals();
    if (!force && t.failed <= failedAtSuccess && t.dropped === 0) return;
    burstLogged = true;
    const why = lastError?.status != null ? `status=${lastError.status}` : lastError?.code ? `code=${lastError.code}` : lastError?.name ? `error=${lastError.name}` : 'status=unknown';
    try { log(`[tailor:telemetry] export failing: ${why} failedSpans=${Math.max(0, t.failed)} droppedSpans=${Math.max(0, t.dropped)} (spans are not retried after a rejected batch)`); } catch { /* logging must not throw */ }
  };
  if (mode === 'neatlogs') {
    const noteError = (error: unknown) => {
      if (closed) return;
      lastError = summarizeError(error);
      setImmediate(() => logBurst(true)).unref();
    };
    // Background batch failures never reach the caller; the OTel global error handler is the only place they surface.
    setGlobalErrorHandler(noteError);
    // Explicit/shutdown flushes reject provider.forceFlush() (the SDK then logs and swallows it): observe it on our own provider.
    const forceFlush = provider.forceFlush.bind(provider);
    provider.forceFlush = async () => { try { await forceFlush(); } catch (error) { noteError(error); throw error; } };
  }

  const scrub = (attributes: Record<string, unknown>) => {
    const safe = { ...attributes };
    if (typeof safe.reservationRef === 'string' && !/^z[0-9a-f]{16}$/.test(safe.reservationRef)) safe.reservationRef = safeRef('z', safe.reservationRef);
    const r = cleanAttributes(safe, hashRef, vocab);
    diag.droppedAttributes += r.dropped; diag.redactedValues += r.redacted;
    return r;
  };
  const forTurn = (turnId: string, sessionId: string, turnOptions: TurnOptions = {}): RuntimeTurnTelemetry => {
    turnOptions = { ...options.versions, ...turnOptions };
    const correlationId = correlationIdFor(secret, sessionId);
    const turnRef = turnRefFor(turnId);
    const sessionRef = `s${correlationId}`;
    const demoRef = safeRef('d', turnOptions.demoId ?? sessionId);
    const requestRef = safeRef('q', turnOptions.requestId ?? turnId);
    const clientTurnRef = safeRef('c', turnOptions.clientTurnId ?? turnId);
    const summary = turns.track(turnId, turnRef, correlationId, requestRef);
    Object.assign(summary, { sessionRef, demoRef, requestRef, clientTurnRef });
    const stepOrdinals = new Map<string, number>();
    const evidence = createEvidenceObserver({
      ...(turnOptions.manifest ? { manifest: turnOptions.manifest } : {}),
      onChange(snapshot) { summary.evidence = snapshot; summary.completeness = compareEvidence(snapshot); try { turnOptions.onEvidence?.(snapshot); } catch { diag.evidenceFailures++; } },
      onReceipt(receipt) { guard(() => { const span = targetSpan(turnId); if (span) span.addEvent('tailor.evidence', scrub({ evidenceKey: receipt.key, operation: receipt.operation, evidenceOrdinal: receipt.ordinal, evidencePhase: receipt.phase, evidenceStatus: receipt.status }).clean); }); },
    });
    summary.evidence = evidence.snapshot(); summary.completeness = compareEvidence(summary.evidence);
    declareInto(vocab, { codeVersions: turnOptions.codeVersion ? [turnOptions.codeVersion] : [], adapterVersions: turnOptions.adapterVersion ? [turnOptions.adapterVersion] : [], policyVersions: turnOptions.policyVersion ? [turnOptions.policyVersion] : [], contractVersions: turnOptions.contractVersion ? [turnOptions.contractVersion] : [] });
    const versions = Object.fromEntries(Object.entries(turnOptions).filter(([k]) => ['codeVersion', 'adapterVersion', 'contractVersion', 'contextSchemaVersion', 'policyVersion'].includes(k)));
    const synthetic = syntheticPayloads && turnOptions.synthetic === true;
    return {
      turnId, turnRef, correlationId, sessionRef, demoRef, requestRef, clientTurnRef, evidence,
      declare(vocabulary: SafeVocabulary) { guard(() => declareInto(vocab, vocabulary)); },
      async step<T>(name: RuntimeStep, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
        if (pending >= LIMITS.telemetryQueueMax) { diag.droppedSteps++; return fn(); }
        pending++;
        const ordinal = typeof attributes.evidenceOrdinal === 'number' && Number.isInteger(attributes.evidenceOrdinal) && attributes.evidenceOrdinal > 0 ? attributes.evidenceOrdinal : (stepOrdinals.get(name) ?? 0) + 1;
        stepOrdinals.set(name, ordinal);
        const box: { ran: boolean; result?: { ok: true; value: T } | { ok: false; error: unknown } } = { ran: false };
        try {
          const { clean, dropped } = scrub({ ...versions, ...attributes });
          const attrs: Record<string, AttrValue> = { ...clean, 'tailor.turn_id': turnRef, 'tailor.correlation_id': correlationId, 'tailor.step': name, 'tailor.session_ref': sessionRef, 'tailor.demo_ref': demoRef, 'tailor.request_ref': requestRef, 'tailor.client_turn_ref': clientTurnRef };
          if (['model', 'repair', 'escalate'].includes(name)) attrs['tailor.model_call'] = true;
          if (dropped) attrs['tailor.dropped_attributes'] = dropped;
          const traceOptions: TraceOptions = name === 'turn'
            ? { name: 'tailor.turn', kind: 'WORKFLOW', sessionId: correlationId, ...(turnOptions.endUserId ? { endUserId: safeRef('u', turnOptions.endUserId) } : {}), attributes: attrs }
            : { name: STEP_KINDS[name] ? name : 'step', kind: STEP_KINDS[name] ?? 'CHAIN', attributes: attrs };
          await trace(traceOptions, async (span) => {
            box.ran = true;
            const started = performance.now();
            if (name === 'turn') { roots.set(turnId, span); guard(() => { summary.traceId = span.spanContext().traceId; }); }
            try {
              const value = await context.run({ turnId, span }, async () => {
                guard(() => evidence.observe(name as EvidenceOperation, ordinal, 'start', 'ok'));
                try {
                  const value = await fn();
                  const recorded = (span as unknown as { attributes?: Record<string, unknown> }).attributes ?? {};
                  const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : undefined;
                  const failed = (name === 'save' && state === 'save_failed') || (name === 'guard' && (recorded['tailor.attempt_result'] === 'error' || recorded['tailor.provider_error_kind'] !== undefined));
                  guard(() => evidence.observe(name as EvidenceOperation, ordinal, 'end', failed ? 'failed' : 'ok')); return value;
                }
                catch (error) { guard(() => evidence.observe(name as EvidenceOperation, ordinal, 'end', 'failed')); throw error; }
              });
              box.result = { ok: true, value };
              guard(() => {
                span.setAttribute('tailor.status', 'ok');
                const v = value as { outcome?: unknown; version?: unknown; conversationVersion?: unknown; demoId?: unknown } | null;
                if (v && typeof v === 'object') {
                  if (name === 'turn' && typeof v.demoId === 'string') { const targetDemoRef = safeRef('d', v.demoId); if (targetDemoRef !== demoRef) { summary.sourceDemoRef = demoRef; summary.demoRef = targetDemoRef; span.setAttribute('tailor.source_demo_ref', demoRef); span.setAttribute('tailor.demo_ref', targetDemoRef); } }
                  if (typeof v.outcome === 'string' && TURN_OUTCOMES.has(v.outcome)) span.setAttribute('tailor.outcome', v.outcome);
                  if (typeof v.version === 'number' && Number.isFinite(v.version)) { span.setAttribute('tailor.version', v.version); if (name === 'turn') summary.version = v.version; }
                  if (typeof v.conversationVersion === 'number' && Number.isFinite(v.conversationVersion)) { span.setAttribute('tailor.conversation_version', v.conversationVersion); if (name === 'turn') summary.conversationVersion = v.conversationVersion; }
                }
              });
            } catch (error) {
              box.result = { ok: false, error };
              const code = errorCodeOf(error);
              guard(() => { span.setAttribute('tailor.status', 'failed'); span.setAttribute('tailor.error_code', code); });
              throw new StepFailed(code);
            } finally {
              guard(() => span.setAttribute('tailor.duration_ms', Math.round(performance.now() - started)));
              if (name === 'turn') roots.delete(turnId);
            }
          });
        } catch (e) {
          if (!(e instanceof StepFailed)) diag.sdkFailures++;
        } finally { pending--; }
        if (!box.ran || !box.result) return fn();
        if (name === 'turn') guard(() => {
          const r = box.result!;
          summary.status = r.ok ? 'ok' : 'failed';
          const o = r.ok ? (r.value as { outcome?: unknown } | null)?.outcome : undefined;
          summary.outcome = typeof o === 'string' && TURN_OUTCOMES.has(o) ? o : null;
        });
        if (box.result.ok) return box.result.value;
        throw box.result.error;
      },
      event(name: string, attributes: Record<string, string | number | boolean>) {
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          span.addEvent(`tailor.${EVENT_NAMES.has(name) ? name : 'event'}`, scrub(attributes).clean);
        });
      },
      annotate(attributes: Record<string, string | number | boolean>) {
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          const { clean } = scrub(attributes);
          if (Object.keys(clean).length) span.setAttributes(clean);
        });
      },
      attachSynthetic(io: { input?: string; output?: string }): boolean {
        if (!synthetic) return false;
        let attached = false;
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          span.setAttribute('tailor.synthetic', true);
          for (const [key, text] of [['tailor.synthetic_input', io.input], ['tailor.synthetic_output', io.output]] as const) {
            if (typeof text !== 'string' || !text) continue;
            const value = text.slice(0, SYNTHETIC_MAX_CHARS);
            if (looksSensitive(value)) { diag.droppedAttributes++; diag.redactedValues++; continue; }
            span.setAttribute(key, value);
            span.setAttribute(`${key}_truncated`, text.length > SYNTHETIC_MAX_CHARS);
            attached = true;
          }
        });
        return attached;
      },
      recordUsage(usage: ProviderUsage | null, model: string | null) {
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          if (model !== null) {
            if (Object.hasOwn(MODEL_RATES, model) || vocab.modelIds.has(model)) span.setAttribute('tailor.model', model); else diag.droppedAttributes++;
          }
          if (!usage) { span.setAttribute('tailor.usage.available', false); return; }
          const ok = finiteNonNegative(usage.inputTokens) && finiteNonNegative(usage.outputTokens);
          span.setAttribute('tailor.usage.available', ok);
          if (ok) {
            span.setAttribute('tailor.usage.input_tokens', usage.inputTokens); span.setAttribute('tailor.usage.output_tokens', usage.outputTokens);
            // Optional provider-reported detail; absent means not reported (never written as zero).
            if (finiteNonNegative(usage.cacheReadInputTokens)) span.setAttribute('tailor.usage.cache_read_input_tokens', usage.cacheReadInputTokens as number);
            // Cache writes keep the provider's name (cache_creation); prompt caching is not enabled yet, so normally absent.
            if (finiteNonNegative(usage.cacheCreationInputTokens)) span.setAttribute('tailor.usage.cache_creation_input_tokens', usage.cacheCreationInputTokens as number);
            if (finiteNonNegative(usage.thinkingTokens)) span.setAttribute('tailor.usage.thinking_tokens', usage.thinkingTokens as number);
          }
        });
      },
    };
  };

  /**
   * Flush + judge. Snapshots delivery counters around the flush: success is never reported when failures or drops
   * increased, nor while an earlier failure is unresolved (the failed batch is gone, so an empty re-flush proves nothing).
   * There is deliberately no flush retry loop: the OTLP transport already retries 429/5xx, and a rejected batch cannot be re-sent.
   */
  const doFlush = async (timeoutMs: number): Promise<FlushResult> => {
    const endedAtStart = counter.ended;
    let sdkOk = true;
    const work = (async () => {
      try { if (!(await sdkFlush())) sdkOk = false; } catch { diag.sdkFailures++; sdkOk = false; }
      try { await provider.forceFlush(); } catch { diag.sdkFailures++; sdkOk = false; }
    })();
    const timedOut = (await bounded(work, timeoutMs)) === 'timeout';
    const t = totals();
    const failed = Math.max(0, t.failed - flushedFailed);
    const dropped = Math.max(0, t.dropped - flushedDropped);
    flushedFailed = t.failed; flushedDropped = t.dropped;
    let exported = 0;
    if (!timedOut) {
      const total = Math.max(0, endedAtStart - t.failed - t.dropped);
      exported = Math.max(0, total - settledExported);
      settledExported = Math.max(settledExported, total);
    }
    const clean = sdkOk && !timedOut && failed === 0 && dropped === 0;
    const recovers = clean && exported > 0;
    const unresolved = mode === 'neatlogs' && t.failed > failedAtSuccess;
    const ok = clean && (!unresolved || recovers);
    if (recovers && mode === 'neatlogs') { failedAtSuccess = t.failed; burstLogged = false; }
    if (ok && exported > 0) lastSuccessAt = new Date().toISOString();
    logBurst(false);
    return { ok, exported, failed, state: stateNow(), timedOut, receiptState: 'unverified' };
  };

  const doShutdown = async (): Promise<ShutdownResult> => {
    const budget = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const left = () => Math.max(250, deadline - Date.now());
    const fl = await doFlush(budget);
    let timedOut = fl.timedOut;
    let shutdownOk = true;
    let sdkResult: unknown = true;
    const sdkOutcome = await bounded(sdkShutdown('tailor-telemetry-shutdown', left()).then(r => { sdkResult = r; }), left() + 500);
    if (sdkOutcome === 'timeout') timedOut = true;
    if (sdkOutcome !== 'ok') { shutdownOk = false; if (sdkOutcome === 'failed') diag.sdkFailures++; }
    if (sdkResult === false) shutdownOk = false;
    const providerOutcome = await bounded(provider.shutdown(), left() + 500);
    if (providerOutcome === 'timeout') timedOut = true;
    if (providerOutcome !== 'ok') { shutdownOk = false; if (providerOutcome === 'failed') diag.sdkFailures++; }
    const t = totals();
    const extraFailed = Math.max(0, t.failed - flushedFailed);
    const extraDropped = Math.max(0, t.dropped - flushedDropped);
    if (extraFailed > 0) logBurst(false);
    frozen = { failed: t.failed, dropped: t.dropped, queued: queuedNow() };
    closed = true;
    if (mode === 'neatlogs') setGlobalErrorHandler(loggingErrorHandler());
    if (active === telemetry) active = null;
    const result: ShutdownResult = {
      ok: fl.ok && shutdownOk && !timedOut && extraFailed === 0 && extraDropped === 0,
      exported: fl.exported, failed: fl.failed + extraFailed, state: stateNow(), timedOut,
    };
    // Exactly one final line per process lifetime (shutdown is memoised): the operator always learns the final verdict.
    if (mode === 'neatlogs') {
      try { log(`[tailor:telemetry] shutdown: delivery state=${result.state} ok=${result.ok} exported=${result.exported} failed=${result.failed} totalFailedSpans=${t.failed} droppedSpans=${t.dropped}${result.timedOut ? ' timedOut=true' : ''}`); } catch { /* logging must not throw */ }
    }
    return result;
  };

  let shutdownPromise: Promise<ShutdownResult> | null = null;
  const telemetry: Telemetry = {
    mode,
    forTurn,
    async guidanceEvent(sessionId, demoId, event) {
      if (closed || pending >= LIMITS.telemetryQueueMax) return false;
      pending++;
      try {
        const attrs = scrub({ guidanceOutcome: event.outcome, guidanceTarget: event.targetId,
          ...(event.reason ? { guidanceReason: event.reason } : {}), version: event.version,
          sessionRef: `s${correlationIdFor(secret, sessionId)}`, demoRef: safeRef('d', demoId),
          messageRef: safeRef('m', event.messageId), suggestionRef: safeRef('g', event.suggestionId), targetRef: safeRef('x', event.targetKey) }).clean;
        await trace({ name: 'tailor.guidance', kind: 'CHAIN', attributes: { ...attrs, ...(syntheticPayloads && event.synthetic === true ? { 'tailor.synthetic': true } : {}) } }, async span => {
          span.addEvent('tailor.guidance', attrs);
          recentGuidance.push({ traceId: span.spanContext().traceId, outcome: event.outcome, demoRef: String(attrs['tailor.demo_ref']), messageRef: String(attrs['tailor.message_ref']) });
          if (recentGuidance.length > 40) recentGuidance.shift();
        });
        return true;
      } catch { diag.sdkFailures++; return false; }
      finally { pending--; }
    },
    flush: () => {
      if (shutdownPromise) return shutdownPromise;
      return doFlush(options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS).catch(() => ({ ok: false, exported: 0, failed: 0, state: stateNow(), timedOut: false }));
    },
    shutdown: () => (shutdownPromise ??= doShutdown().catch(() => ({ ok: false, exported: 0, failed: 0, state: stateNow(), timedOut: false }))),
    captured: () => capture.spans.map(s => structuredClone(s)),
    diagnostics: () => {
      const t = totals();
      if (!closed) logBurst(false);
      return {
        mode, receiptState: 'unverified', recentGuidance: recentGuidance.map(item => ({ ...item })), captureEvictions: capture.evictions, missingEvents: turns.snapshot().reduce((n, t) => n + (t.completeness?.missing.length ?? 0), 0), failedEvents: turns.snapshot().reduce((n, t) => n + (t.completeness?.failed.length ?? 0), 0), deliveryState: stateNow(), ...diag, syntheticPayloads, endpoint,
        exportFailures: t.failed, droppedExports: t.dropped, droppedSpans: t.dropped,
        queued: queuedNow(), exportedSpans: settledExported, markerSpans: counter.markers,
        lastExportError: exporter?.lastError ?? lastError, lastSuccessfulExportAt: lastSuccessAt,
        recentTurns: turns.snapshot(),
      };
    },
  };
  active = telemetry;
  return telemetry;
}
