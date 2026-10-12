// SessionTools bound to ONE authorised session (NIT-273). No method accepts a session ID, so the agent and
// the model cannot reach another buyer's data.
import type { TraceQuery } from './contracts.ts';
import type { Clock, PublishResult, ScenarioProposal, SessionTools, TurnTelemetry } from './agent-contract.ts';
import { findTrace, traceList, traceQuery, type PublishObserver, type Store } from '../../infrastructure/store.ts';
import { validateProposal } from './validator.ts';

/** Business-owned declaration precedes each actual independent committed-data read. */
export function readbackObserver(telemetry?: TurnTelemetry): PublishObserver {
  return { readback(read) {
    const evidence = telemetry?.evidence;
    const ordinal = Math.max(0, ...(evidence?.snapshot().expected.filter(e => e.operation === 'readback').map(e => e.ordinal) ?? [])) + 1;
    evidence?.expect('readback', ordinal);
    evidence?.observe('readback', ordinal, 'start', 'ok');
    const started = performance.now();
    try { const result = read(); evidence?.observe('readback', ordinal, 'end', 'ok'); telemetry?.event('readback.result', { state: 'committed', version: result.version, latencyMs: Math.round(performance.now() - started), evidenceOrdinal: ordinal }); return result; }
    catch (error) { evidence?.observe('readback', ordinal, 'end', 'failed'); telemetry?.event('readback.result', { state: 'readback_uncertain', latencyMs: Math.round(performance.now() - started), evidenceOrdinal: ordinal }); throw error; }
  } };
}

const publishAttributes = (r: PublishResult): Record<string, string | number> => {
  if (r.state === 'committed') return { state: r.state, version: r.version, traceCount: r.readback.traceIds.length, spanCount: r.readback.spanIds.length };
  if (r.state === 'rejected') return { state: r.state, version: r.version, problemCount: r.problems.length };
  if (r.state === 'conflict') return { state: r.state, currentVersion: r.currentVersion };
  if (r.state === 'save_failed') return { state: r.state, version: r.version };
  if (r.state === 'readback_uncertain') return { state: r.state, attemptedVersion: r.attemptedVersion, lastKnownVersion: r.lastKnownVersion };
  return { state: r.state };
};

/**
 * `telemetry` (optional) wraps backend-owned validate/save steps; payloads are never attached.
 * `turn` (optional) ties publishes to the durable turn run, which is marked published in the save transaction.
 */
export function createSessionTools(store: Store, sessionId: string, clock: Clock, telemetry?: TurnTelemetry, turn?: { clientTurnId: string; requestedText?: string; signal?: AbortSignal }): SessionTools {
  const step = <T>(name: 'validate' | 'save', attrs: Record<string, string | number | boolean>, fn: () => Promise<T>) => {
    const ordinal = Math.max(0, ...(telemetry?.evidence?.snapshot().expected.filter(e => e.operation === name).map(e => e.ordinal) ?? [])) + 1;
    telemetry?.evidence?.expect(name, ordinal);
    return telemetry ? telemetry.step(name, { ...attrs, evidenceOrdinal: ordinal }, fn) : fn();
  };
  return {
    async readSession() { return store.snapshot(sessionId); },
    async readTraces(query?: TraceQuery) {
      const session = store.read(sessionId);
      const q = traceQuery({ ...(query ?? {}) } as Record<string, unknown>, session.dataset.traces.map(t => t.scenario));
      return traceList(session, q);
    },
    async readTrace(traceId: string) {
      const session = store.read(sessionId);
      const trace = findTrace(session, traceId);
      return trace ? { version: session.version, trace } : null;
    },
    async prepareScenario(proposal: ScenarioProposal) { return store.prepareScenario(sessionId, proposal, turn?.requestedText ?? 'Switch to another fictional workflow.'); },
    async publishScenario(proposal: ScenarioProposal) {
      if (turn?.signal?.aborted) return { state: 'save_failed' as const, version: store.read(sessionId).version, reason: 'The request was cancelled before saving.' };
      const expectedVersion = typeof proposal?.expectedVersion === 'number' ? proposal.expectedVersion : -1;
      return step('save', { expectedVersion }, async () => {
        const result = store.publish(sessionId, proposal, turn, readbackObserver(telemetry));
        telemetry?.event('publish.result', publishAttributes(result));
        return result;
      });
    },
    async validateProposal(proposal: ScenarioProposal) {
      return step('validate', {}, async () => {
        const session = store.read(sessionId);
        const verdict = validateProposal(sessionId, session.dataset, proposal, clock);
        telemetry?.event('validate.result', { state: verdict.ok ? 'ok' : 'rejected', problemCount: verdict.ok ? 0 : verdict.problems.length });
        return verdict.ok ? { ok: true as const } : { ok: false as const, problems: verdict.problems };
      });
    },
  };
}
