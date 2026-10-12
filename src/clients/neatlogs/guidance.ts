// Read-only adapter-owned destinations. The provider selects names; code supplies copy and saved IDs.
import type { GuidanceSuggestion } from '../../tailor/contract.ts';
import type { GuidanceSelection, SessionSnapshot } from './agent-contract.ts';
export type { GuidanceSelection } from './agent-contract.ts';
export type ContextualGuidance = GuidanceSuggestion & {
  binding: { sessionId: string; version: number; scenario: string; traceId: string; spanId: string | null; openTraceId: string | null };
};
export const GUIDANCE_TARGETS = {
  'trace.overview': { label: 'Inspect this request', purpose: 'See the saved steps and timing for this synthetic request.' },
  'trace.slowest-span': { label: 'Inspect the slowest step', purpose: 'Look at the step with the longest recorded duration.' },
  'trace.model-call': { label: 'Inspect the model call', purpose: 'Read the saved input and output of this model step.' },
  'trace.output': { label: 'Review the request output', purpose: 'Check the saved outcome of this synthetic request.' },
} as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Bad guidance never makes an otherwise valid answer unusable. Extra fields cannot smuggle actions. */
export function parseGuidanceSelections(value: unknown): GuidanceSelection[] {
  if (!Array.isArray(value) || value.length > 3) return [];
  const seen = new Set<string>();
  return value.flatMap(v => {
    if (!object(v) || typeof v.targetId !== 'string' || !Object.hasOwn(GUIDANCE_TARGETS, v.targetId) || Object.keys(v).some(k => !['targetId', 'traceId'].includes(k))) return [];
    if (v.traceId !== undefined && v.traceId !== null && (typeof v.traceId !== 'string' || !v.traceId.trim() || v.traceId.length > 200)) return [];
    const key = `${v.targetId}:${v.traceId ?? ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ targetId: v.targetId as GuidanceSelection['targetId'], ...(typeof v.traceId === 'string' ? { traceId: v.traceId } : {}) }];
  });
}
/** Resolve only the current authorised detail. No comparisons, external actions or data mutations. */
export function resolveGuidance(value: unknown, session: SessionSnapshot, openTraceId?: string): ContextualGuidance[] {
  if (session.state !== 'active') return [];
  const trace = openTraceId ? session.dataset.traces.find(t => t.id === openTraceId) : session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario);
  if (!trace || trace.sessionId !== session.id) return [];
  const resolved = new Set<string>();
  return parseGuidanceSelections(value).flatMap(selection => {
    if (selection.traceId !== undefined && selection.traceId !== trace.id) return [];
    const span = selection.targetId === 'trace.model-call' ? trace.spans.find(s => s.kind === 'LLM')
      : selection.targetId === 'trace.slowest-span' ? trace.spans.filter(s => s.parentId !== null).reduce<typeof trace.spans[number] | undefined>((best, s) => !best || s.durationMs > best.durationMs ? s : best, undefined) : undefined;
    if (['trace.model-call', 'trace.slowest-span'].includes(selection.targetId) && !span) return [];
    const id = `${selection.targetId}:${session.version}:${trace.id}`;
    if (resolved.has(id)) return [];
    resolved.add(id);
    return [{ id, targetId: selection.targetId, ...GUIDANCE_TARGETS[selection.targetId],
      binding: { sessionId: session.id, version: session.version, scenario: session.dataset.activeScenario, traceId: trace.id, spanId: span?.id ?? null, openTraceId: openTraceId ?? null } }];
  });
}
/** Bounded persistence validation, separate from provider input; bindings are checked again before use. */
export function sanitiseStoredGuidance(value: unknown): ContextualGuidance[] {
  if (!Array.isArray(value) || value.length > 3) return [];
  return value.flatMap(v => {
    if (!object(v) || typeof v.targetId !== 'string' || !Object.hasOwn(GUIDANCE_TARGETS, v.targetId) || typeof v.id !== 'string' || v.id.length > 450 || !object(v.binding)) return [];
    const b = v.binding;
    if (typeof b.sessionId !== 'string' || typeof b.scenario !== 'string' || typeof b.traceId !== 'string' || !Number.isSafeInteger(b.version) || (b.version as number) < 0 || ![b.spanId,b.openTraceId].every(x => x === null || typeof x === 'string') || [b.sessionId,b.scenario,b.traceId,b.spanId,b.openTraceId].some(x => typeof x === 'string' && x.length > 200)) return [];
    const targetId = v.targetId as GuidanceSelection['targetId'];
    return [{ id: v.id, targetId, ...GUIDANCE_TARGETS[targetId], binding: { sessionId: b.sessionId, version: b.version as number, scenario: b.scenario, traceId: b.traceId, spanId: b.spanId as string | null, openTraceId: b.openTraceId as string | null } }];
  });
}

/** Share binding checks between the browser and event receipt; callers still observe rendered targets. */
export function isCurrentGuidance(value: unknown, session: Pick<SessionSnapshot, 'id' | 'version' | 'state' | 'dataset'>): value is ContextualGuidance {
  const clean = sanitiseStoredGuidance([value])[0];
  if (!clean || session.state !== 'active') return false;
  const b = clean.binding;
  if (clean.id !== `${clean.targetId}:${b.version}:${b.traceId}`) return false;
  if (b.sessionId !== session.id || b.version !== session.version || b.scenario !== session.dataset.activeScenario) return false;
  const trace = session.dataset.traces.find(t => t.id === b.traceId && t.sessionId === session.id);
  if (!trace) return false;
  if (b.openTraceId !== null && b.openTraceId !== trace.id) return false;
  if (['trace.model-call','trace.slowest-span'].includes(clean.targetId)) {
    const span = trace.spans.find(s => s.id === b.spanId);
    if (!span || (clean.targetId === 'trace.model-call' && span.kind !== 'LLM')) return false;
    const expected = clean.targetId === 'trace.model-call' ? trace.spans.find(s => s.kind === 'LLM')
      : trace.spans.filter(s => s.parentId !== null).reduce<typeof trace.spans[number] | undefined>((best, s) => !best || s.durationMs > best.durationMs ? s : best, undefined);
    if (expected?.id !== span.id) return false;
  } else if (b.spanId !== null) return false;
  return true;
}
