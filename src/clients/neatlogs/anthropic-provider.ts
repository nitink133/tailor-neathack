// Neatlogs wire codec for the live Anthropic transport. The model returns ONE structured AgentAction; OUR server
// validates and executes it. No tools / tool_choice are used. The transport (src/tailor/anthropic-transport.ts) owns the
// request, spend reservation, timeout and stop-reason mapping; this module owns the Neatlogs schemas and decoding.
//
// JSON REPRESENTATION. The structured-output grammar cannot express arbitrary JSON, so every free-form `input` / `output`
// (trace level and span level) travels as a STRING that holds JSON text. The codec decodes it server-side, bounded by
// LIMITS.maxSpanJsonBytes, and checks `isJson` before `validateAgentAction` sees the value. Optional TypeScript fields are
// required-but-nullable on the wire (structured outputs list every property) and normalised null -> absent.

import {
  CONTRACT_VERSION, LIMITS,
  type AgentAction, type EvidenceExplanation, type ExplanationRequest, type ExplanationResponse, type ModelProvider,
  type ProviderRequest, type ProviderResponse,
} from './agent-contract.ts';
import { isJson } from '../../tailor/json.ts';
import { createAnthropicTransport, type AnthropicTransportOptions } from '../../tailor/anthropic-transport.ts';
import { validateAgentAction, validateEvidenceExplanation } from './provider.ts';
import { POLICY_DECISION_SCHEMA, POLICY_LIMITS, decodePolicyDecision, type PolicyRequest, type PolicyResponse } from '../../tailor/policy.ts';

export {
  ProviderError, DEFAULT_EFFORT, DEFAULT_MODEL, mapSdkError, maxOutputTokensFor, toAnthropicMessages, toProviderUsage,
  type AnthropicMessageParams, type Effort, type MessagesClientLike, type OutputFormatLike, type RawMessageLike, type RequestOptionsLike,
} from '../../tailor/anthropic-transport.ts';
export type AnthropicProviderOptions = AnthropicTransportOptions & { guardModel?: string };

// ---------------------------------------------------------------------------------------------------------------------
// Schemas (plain `as const` objects). Rules: additionalProperties:false on every object, every property required,
// no minimum/maximum/minLength/maxLength/pattern/minItems. Sizes and counts are enforced by the validator after decoding.
// ---------------------------------------------------------------------------------------------------------------------
const str = (description?: string) => (description ? { type: 'string', description } as const : { type: 'string' } as const);
const nullableStr = (description?: string) => (description ? { type: ['string', 'null'], description } as const : { type: ['string', 'null'] } as const);
const strArray = { type: 'array', items: { type: 'string' } } as const;
const jsonText = (what: string) => ({ type: 'string', description: `${what} as JSON text (a JSON-encoded string, at most ${LIMITS.maxSpanJsonBytes} bytes), e.g. "{\\"key\\":\\"value\\"}"` }) as const;

const PROPOSED_SPAN = {
  type: 'object',
  properties: {
    key: str('Stable span key: lowercase letters, digits and hyphens, at most 40 characters'),
    parentKey: nullableStr('Key of the parent span; null for the single root span'),
    name: str(),
    kind: { type: 'string', enum: ['WORKFLOW', 'GUARDRAIL', 'TOOL', 'RETRIEVAL', 'CHAIN', 'AGENT', 'LLM'] },
    startMs: { type: 'integer', description: 'Milliseconds from the start of the trace' },
    durationMs: { type: 'integer' },
    status: { type: 'string', enum: ['OK', 'ERROR'] },
    input: jsonText('Span input'),
    output: jsonText('Span output'),
    error: nullableStr('Non-null (starting "SYNTHETIC:") exactly when status is ERROR'),
    detection: { type: 'boolean', description: 'Only true on ERROR spans' },
  },
  required: ['key', 'parentKey', 'name', 'kind', 'startMs', 'durationMs', 'status', 'input', 'output', 'error', 'detection'],
  additionalProperties: false,
} as const;

const PROPOSED_TRACE = {
  type: 'object',
  properties: {
    key: str('Scenario key: lowercase letters, digits and hyphens, at most 40 characters'),
    label: str(),
    name: str(),
    outcome: str(),
    outcomeKind: { type: 'string', enum: ['success', 'degraded', 'failure', 'escalation'] },
    tags: strArray,
    input: jsonText('Trace input'),
    output: jsonText('Trace output; must be identical to the root span output'),
    spans: { type: 'array', items: PROPOSED_SPAN },
  },
  required: ['key', 'label', 'name', 'outcome', 'outcomeKind', 'tags', 'input', 'output', 'spans'],
  additionalProperties: false,
} as const;

/**
 * Scenario proposal on the wire. `kind` and `contractVersion` are constants the server injects after decoding;
 * the model never emits them (fewer grammar symbols, nothing to get wrong).
 */
const SCENARIO_PROPOSAL = {
  type: 'object',
  properties: {
    expectedVersion: { type: 'integer', description: 'The session version this proposal was planned against' },
    mode: { type: 'string', enum: ['new', 'edit'] },
    removeTraceKeys: { type: ['array', 'null'], items: { type: 'string' }, description: 'Trace keys to drop in an edit; null when none' },
    story: {
      type: 'object',
      properties: { domain: str(), summary: str(), assumptions: strArray },
      required: ['domain', 'summary', 'assumptions'],
      additionalProperties: false,
    },
    activeScenario: str('Key of one proposed trace'),
    traces: { type: 'array', items: PROPOSED_TRACE },
  },
  required: ['expectedVersion', 'mode', 'removeTraceKeys', 'story', 'activeScenario', 'traces'],
  additionalProperties: false,
} as const;

const CLARIFICATION = {
  type: 'object',
  properties: {
    question: str(),
    choices: { type: 'array', description: 'Exactly three distinct choices with ids c1, c2, c3', items: { type: 'object', properties: { id: str(), label: str() }, required: ['id', 'label'], additionalProperties: false } },
    allowFreeText: { type: 'boolean', description: 'Always true' },
  },
  required: ['question', 'choices', 'allowFreeText'],
  additionalProperties: false,
} as const;

export const ACTION_TYPES = ['ask', 'propose', 'explain', 'answer', 'unsupported', 'refuse'] as const;
export const REFUSAL_REASONS = ['injection', 'arbitrary_code', 'cross_session', 'real_mutation', 'off_topic'] as const;

/**
 * Wire schema for a planning call. The six AgentAction variants are FLATTENED into one object discriminated by
 * `type`, with every variant-specific field nullable: Anthropic's structured-output grammar compiler rejected the
 * natural `anyOf` of six objects as too large ("The compiled grammar is too large"), while this shape compiles.
 * `normaliseWireAction` rebuilds the union and `validateAgentAction` enforces the contract afterwards.
 */
export const AGENT_ACTION_SCHEMA = {
  type: 'object',
  description: 'Exactly one action. Fill only the fields that belong to that action type; every other field must be null.',
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    text: nullableStr('Buyer-facing text for explain, answer, unsupported and refuse; null for ask and propose'),
    clarification: { anyOf: [CLARIFICATION, { type: 'null' }], description: 'ask only' },
    proposal: { anyOf: [SCENARIO_PROPOSAL, { type: 'null' }], description: 'propose only' },
    explanation: nullableStr('propose only: one to three sentences on what the proposal shows'),
    traceId: nullableStr('explain only: id of the saved trace being explained, when known'),
    spanIds: { type: ['array', 'null'], items: { type: 'string' }, description: 'explain only: ids of saved spans the text relies on' },
    knowledgeIds: { type: ['array', 'null'], items: { type: 'string' }, description: 'answer only: ids of the knowledge records used' },
    capabilityId: nullableStr('unsupported only: id of the requested capability, when it matches one'),
    reason: { anyOf: [{ type: 'string', enum: REFUSAL_REASONS }, { type: 'null' }], description: 'refuse only' },
  },
  required: ['type', 'text', 'clarification', 'proposal', 'explanation', 'traceId', 'spanIds', 'knowledgeIds', 'capabilityId', 'reason'],
  additionalProperties: false,
} as const;

/** Wire schema for the evidence-grounded explanation call (matches `EvidenceExplanation`). */
export const EVIDENCE_EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    text: str('One to four plain sentences for the buyer, using only the evidence provided'),
    spanIds: { type: 'array', description: 'Span ids from the evidence that the text relies on', items: { type: 'string' } },
  },
  required: ['text', 'spanIds'],
  additionalProperties: false,
} as const;

/** Appended to the system prompt: the wire format differs from the prose shapes in SYSTEM_PROMPT in these ways only. */
export const WIRE_FORMAT_NOTES = [
  'WIRE FORMAT (structured output): return ONE flat object with `type` set to the action and every field that does not belong to that action set to null.',
  '- ask: `clarification` (question, exactly three choices c1/c2/c3, allowFreeText true). propose: `proposal` + `explanation`. explain: `text` (+ `traceId`, `spanIds` when known). answer: `text` + `knowledgeIds`. unsupported: `text` (+ `capabilityId`). refuse: `text` + `reason`.',
  '- The proposal omits `kind` and `contractVersion`; the server adds them. `expectedVersion` is the current session version.',
  '- Every `input` and `output` (trace and span level) is a JSON-ENCODED STRING, at most 4096 bytes. The trace `output` string must encode exactly the root span output.',
  '- Use null for absent `removeTraceKeys` and for `error` on OK spans; `parentKey` is null only on the root span. `detection` is a boolean (true only on ERROR spans).',
].join('\n');

// Plain schema objects: the schema goes on the wire exactly as written (the SDK helper's default transform demotes
// every `enum` and nullable `items` to description text; that looser schema failed to compile live with "The compiled
// grammar is too large"). Our schemas already follow the structured-output rules (enforced by test).
const PLAN_SCHEMA = AGENT_ACTION_SCHEMA as unknown as Record<string, unknown>;
const EXPLAIN_SCHEMA = EVIDENCE_EXPLANATION_SCHEMA as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------------
// Wire <-> AgentAction
// ---------------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const FAIL = Symbol('decode-failed');

/** Decode a JSON-text field: bounded, valid JSON, and within the Json value domain. */
function decodeJsonText(value: unknown): unknown | typeof FAIL {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > LIMITS.maxSpanJsonBytes) return FAIL;
  try { const parsed: unknown = JSON.parse(value); return isJson(parsed) ? parsed : FAIL; }
  catch { return FAIL; }
}

function decodeSpan(span: unknown): Obj | null {
  if (!isObj(span)) return null;
  const input = decodeJsonText(span.input);
  const output = decodeJsonText(span.output);
  if (input === FAIL || output === FAIL) return null;
  return { ...span, input, output };
}

function decodeTrace(trace: unknown): Obj | null {
  if (!isObj(trace) || !Array.isArray(trace.spans)) return null;
  const input = decodeJsonText(trace.input);
  const output = decodeJsonText(trace.output);
  if (input === FAIL || output === FAIL) return null;
  const spans = trace.spans.map(decodeSpan);
  if (spans.some(s => s === null)) return null;
  return { ...trace, input, output, spans };
}

/**
 * Rebuild an AgentAction from the flat wire object: pick the fields that belong to `type`, decode JSON text,
 * drop nulls, inject the proposal constants. Null = undecodable. `validateAgentAction` does the contract checks.
 */
export function normaliseWireAction(parsed: unknown): unknown | null {
  if (!isObj(parsed)) return null;
  const w = parsed;
  const opt = (key: string): Obj => (w[key] === null || w[key] === undefined ? {} : { [key]: w[key] });
  switch (w.type) {
    case 'ask':
      return { type: 'ask', clarification: w.clarification };
    case 'propose': {
      if (!isObj(w.proposal) || !Array.isArray(w.proposal.traces)) return null;
      const traces = w.proposal.traces.map(decodeTrace);
      if (traces.some(t => t === null)) return null;
      const { removeTraceKeys, ...rest } = w.proposal;
      const proposal: Obj = { kind: 'scenario_proposal', contractVersion: CONTRACT_VERSION, ...rest, ...(removeTraceKeys === null || removeTraceKeys === undefined ? {} : { removeTraceKeys }), traces };
      return { type: 'propose', proposal, explanation: w.explanation };
    }
    case 'explain':
      return { type: 'explain', text: w.text, ...opt('traceId'), ...opt('spanIds') };
    case 'answer':
      return { type: 'answer', text: w.text, knowledgeIds: w.knowledgeIds ?? [] };
    case 'unsupported':
      return { type: 'unsupported', text: w.text, ...opt('capabilityId') };
    case 'refuse':
      return { type: 'refuse', text: w.text, reason: w.reason };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------------
/** Request id, stop reason, known cost and reservation for the core's per-attempt telemetry. */
const accounting = (r: { requestId?: string; stopReason: string; costUsd?: number; reservationUsd: number; reservationRef?: string; settlement?: import('../../tailor/accounting.ts').AttemptSettlement; pricingVersion?: string; inputAccounting?: import('../../tailor/accounting.ts').InputAccounting }) => ({
  ...(r.requestId ? { requestId: r.requestId } : {}),
  stopReason: r.stopReason,
  reservationUsd: r.reservationUsd,
  ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
  ...(r.reservationRef ? { reservationRef: r.reservationRef } : {}),
  ...(r.settlement ? { settlement: r.settlement } : {}),
  ...(r.pricingVersion ? { pricingVersion: r.pricingVersion } : {}),
  ...(r.inputAccounting ? { inputAccounting: r.inputAccounting } : {}),
});

/** What every plan/explain call sends besides the conversation; priced once at creation as the reservation overhead. */
export const ANTHROPIC_FIXED_PARTS = { plan: { extraSystem: WIRE_FORMAT_NOTES, schema: PLAN_SCHEMA }, explain: { schema: EXPLAIN_SCHEMA }, guard: { schema: POLICY_DECISION_SCHEMA } };

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const transport = createAnthropicTransport({ ...options, fixedParts: ANTHROPIC_FIXED_PARTS });
  const guardTransport = options.guardModel && options.guardModel !== transport.model
    ? createAnthropicTransport({ ...options, model: options.guardModel, effort: 'low', timeoutMs: Math.min(options.timeoutMs ?? POLICY_LIMITS.timeoutMs, POLICY_LIMITS.timeoutMs), fixedParts: { guard: ANTHROPIC_FIXED_PARTS.guard } })
    : transport;
  return {
    name: transport.name,
    model: transport.model,
    mode: transport.mode,
    effort: transport.effort,
    async classifyPolicy(request: PolicyRequest, signal?: AbortSignal): Promise<PolicyResponse> {
      const result = await guardTransport.call({
        kind: 'guard', messages: request.messages, maxTokens: Math.min(request.maxOutputTokens, POLICY_LIMITS.maxOutputTokens),
        timeoutMs: POLICY_LIMITS.timeoutMs, schema: POLICY_DECISION_SCHEMA, extract: decodePolicyDecision,
      }, signal);
      return { decision: result.value, usage: result.usage, latencyMs: result.latencyMs, guardModel: guardTransport.model, ...accounting(result) };
    },
    async complete(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
      const result = await transport.call<AgentAction>({
        kind: 'plan', messages: request.messages, extraSystem: WIRE_FORMAT_NOTES, maxTokens: request.maxOutputTokens, schema: PLAN_SCHEMA,
        extract: parsed => { const wire = normaliseWireAction(parsed); return wire === null ? null : validateAgentAction(wire); },
      }, signal);
      return { action: result.value, usage: result.usage, latencyMs: result.latencyMs, ...accounting(result) };
    },
    async explain(request: ExplanationRequest, signal?: AbortSignal): Promise<ExplanationResponse> {
      const result = await transport.call<EvidenceExplanation>({
        kind: 'explain', messages: request.messages, maxTokens: request.maxOutputTokens, schema: EXPLAIN_SCHEMA,
        extract: parsed => validateEvidenceExplanation(parsed),
      }, signal);
      return { explanation: result.value, usage: result.usage, latencyMs: result.latencyMs, ...accounting(result) };
    },
  };
}
