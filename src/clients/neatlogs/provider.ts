import { parseGuidanceSelections } from './guidance.ts';
// Provider factory + strict structural validation of model output.
// `mock` is the deterministic offline provider. `anthropic` is the live provider: the caller supplies the API key and a
// spend guard (this module never reads the environment) and never falls back to the mock.

import { CONTRACT_VERSION, OUTCOME_KINDS, SPAN_KINDS, type AgentAction, type EvidenceExplanation, type ModelProvider, type ProposedSpan, type ProposedTrace, type ScenarioProposal } from './agent-contract.ts';
import { isJson } from '../../tailor/json.ts';
import { createAnthropicProvider, type AnthropicProviderOptions, type Effort } from './anthropic-provider.ts';
import { createMockProvider } from './mock-provider.ts';
import type { SpendGuard } from '../../tailor/spend.ts';

export type { Effort } from './anthropic-provider.ts';
export { maxOutputTokensFor } from './anthropic-provider.ts';
export { hasRatesFor } from '../../tailor/spend.ts';
export { isJson };
/** No `maxRetries`: the SDK never retries; the service's bounded loop owns retries so every attempt is reserved and settled. */
export type ProviderConfig =
  | { kind: 'mock' }
  | { kind: 'anthropic'; apiKey: string; model?: string; guardModel?: string; effort?: Effort; spend: SpendGuard; timeoutMs?: number; client?: AnthropicProviderOptions['client'] };

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.kind) {
    case 'mock': return createMockProvider();
    case 'anthropic': {
      const { kind: _kind, ...options } = config;
      return createAnthropicProvider(options);
    }
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every(isStr) ? [...v] : null;
}

function readSpan(v: unknown): ProposedSpan | null {
  if (!isObj(v)) return null;
  const { key, parentKey, name, kind, startMs, durationMs, status, input, output, error, detection } = v;
  if (!isStr(key) || !(parentKey === null || isStr(parentKey)) || !isStr(name) || !isStr(kind) || !(SPAN_KINDS as readonly string[]).includes(kind)) return null;
  if (!isNum(startMs) || !isNum(durationMs) || (status !== 'OK' && status !== 'ERROR')) return null;
  if (!isJson(input) || !isJson(output) || !(error === null || isStr(error)) || typeof detection !== 'boolean') return null;
  return { key, parentKey: parentKey as string | null, name, kind: kind as ProposedSpan['kind'], startMs, durationMs, status, input, output, error: error as string | null, detection };
}

function readTrace(v: unknown): ProposedTrace | null {
  if (!isObj(v)) return null;
  const { key, label, name, outcome, outcomeKind, tags, input, output, spans } = v;
  if (!isStr(key) || !isStr(label) || !isStr(name) || !isStr(outcome) || !isStr(outcomeKind) || !(OUTCOME_KINDS as readonly string[]).includes(outcomeKind)) return null;
  const tagList = strings(tags);
  if (!tagList || !isJson(input) || !isJson(output) || !Array.isArray(spans)) return null;
  const readSpans: ProposedSpan[] = [];
  for (const s of spans) { const span = readSpan(s); if (!span) return null; readSpans.push(span); }
  return { key, label, name, outcome, outcomeKind: outcomeKind as ProposedTrace['outcomeKind'], tags: tagList, input, output, spans: readSpans };
}

function readProposal(v: unknown): ScenarioProposal | null {
  if (!isObj(v) || v.kind !== 'scenario_proposal' || v.contractVersion !== CONTRACT_VERSION) return null;
  if (!isNum(v.expectedVersion) || (v.mode !== 'new' && v.mode !== 'edit') || !isStr(v.activeScenario) || !Array.isArray(v.traces) || v.traces.length === 0) return null;
  const story = v.story;
  if (!isObj(story) || !isStr(story.domain) || !isStr(story.summary)) return null;
  const assumptions = strings(story.assumptions);
  if (!assumptions) return null;
  const traces: ProposedTrace[] = [];
  for (const t of v.traces) { const trace = readTrace(t); if (!trace) return null; traces.push(trace); }
  let removeTraceKeys: string[] | undefined;
  if (v.removeTraceKeys !== undefined) { const r = strings(v.removeTraceKeys); if (!r) return null; removeTraceKeys = r; }
  return {
    kind: 'scenario_proposal', contractVersion: CONTRACT_VERSION, expectedVersion: v.expectedVersion, mode: v.mode,
    ...(removeTraceKeys ? { removeTraceKeys } : {}),
    story: { domain: story.domain, summary: story.summary, assumptions }, activeScenario: v.activeScenario, traces,
  };
}

const REFUSE_REASONS = ['injection', 'arbitrary_code', 'cross_session', 'real_mutation', 'off_topic'] as const;

/** Structural validation of an unknown value. Returns a normalised copy (unknown fields dropped) or null. */
export function validateAgentAction(value: unknown): AgentAction | null {
  if (!isObj(value) || !isStr(value.type)) return null;
  switch (value.type) {
    case 'ask': {
      const c = value.clarification;
      if (!isObj(c) || !isStr(c.question) || c.allowFreeText !== true || !Array.isArray(c.choices) || c.choices.length !== 3) return null;
      const choices = c.choices.map(x => (isObj(x) && isStr(x.id) && isStr(x.label) ? { id: x.id, label: x.label } : null));
      if (choices.some(x => x === null)) return null;
      return { type: 'ask', clarification: { question: c.question, choices: choices as [{ id: string; label: string }, { id: string; label: string }, { id: string; label: string }], allowFreeText: true } };
    }
    case 'propose': {
      const proposal = readProposal(value.proposal);
      if (!proposal || !isStr(value.explanation)) return null;
      return { type: 'propose', proposal, explanation: value.explanation, ...(value.guidance !== undefined ? { guidance: parseGuidanceSelections(value.guidance) } : {}) };
    }
    case 'explain': {
      if (!isStr(value.text)) return null;
      const spanIds = value.spanIds === undefined ? undefined : strings(value.spanIds);
      if (spanIds === null) return null;
      if (value.traceId !== undefined && !isStr(value.traceId)) return null;
      return { type: 'explain', text: value.text, ...(value.guidance !== undefined ? { guidance: parseGuidanceSelections(value.guidance) } : {}), ...(isStr(value.traceId) ? { traceId: value.traceId } : {}), ...(spanIds ? { spanIds } : {}) };
    }
    case 'answer': {
      const ids = strings(value.knowledgeIds);
      if (!isStr(value.text) || !ids) return null;
      return { type: 'answer', text: value.text, knowledgeIds: ids, ...(value.guidance !== undefined ? { guidance: parseGuidanceSelections(value.guidance) } : {}) };
    }
    case 'unsupported': {
      if (!isStr(value.text) || (value.capabilityId !== undefined && !isStr(value.capabilityId))) return null;
      return { type: 'unsupported', text: value.text, ...(isStr(value.capabilityId) ? { capabilityId: value.capabilityId } : {}) };
    }
    case 'refuse': {
      if (!isStr(value.text) || !isStr(value.reason) || !(REFUSE_REASONS as readonly string[]).includes(value.reason)) return null;
      return { type: 'refuse', text: value.text, reason: value.reason as (typeof REFUSE_REASONS)[number] };
    }
    default: return null;
  }
}

/** Structural validation of the explanation call's output. Null when it is not `{ text: non-empty string, spanIds: string[] }`. */
export function validateEvidenceExplanation(value: unknown): EvidenceExplanation | null {
  if (!isObj(value) || !isStr(value.text) || value.text.trim().length === 0) return null;
  const spanIds = strings(value.spanIds);
  if (!spanIds) return null;
  return { text: value.text, spanIds };
}

/** Parse model text into exactly one AgentAction. No prose, no code fences, no multiple objects. */
export function parseAgentAction(text: string): AgentAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try { return validateAgentAction(JSON.parse(trimmed)); }
  catch { return null; }
}
