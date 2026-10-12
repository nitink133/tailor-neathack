// Buyer-session lifecycle policy: expiry, sweep horizons, one turn in flight, idempotent turn runs, and the truthful
// reconciliation of an agent result against the authoritative version before anything reaches the transcript.
// Storage and transport live in src/infrastructure; this module only decides.

import { createHash } from 'node:crypto';
import {
  CORE_LIMITS as LIMITS,
  TURN_OUTCOMES,
  type ChatStatus, type ExecutionLabel, type TailorMessage, type TurnOutcome, type TurnResult,
} from './contract.ts';

/** Ended-session tombstones keep End demo idempotent, then are swept. */
export const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
/**
 * A run older than this cannot still be executing (provider calls + explanation call + slack), so the sweep may
 * settle it as interrupted. Runs younger than this are only settled on a same-ID retry when no process holds them.
 */
export const TURN_DEADLINE_MS = (LIMITS.maxProviderCallsPerTurn + 1) * LIMITS.providerTimeoutMs + 60_000;
/** Settled runs kept per session so an older retry replays instead of running again. */
export const TURN_RUNS_PER_SESSION = 16;

export const CHAT_STATUSES: readonly ChatStatus[] = ['pending', 'applied', 'failed', 'uncertain', 'question', 'note'];

/** Idle or past its lifetime, by the server clock. */
export function isSessionExpired(lastActiveAt: number, expiresAt: number, now: number): boolean {
  return now - lastActiveAt > LIMITS.idleMs || now >= expiresAt;
}

/** Final status of the pending buyer turn, by outcome. */
export const BUYER_STATUS: Record<TurnOutcome, ChatStatus> = {
  committed: 'applied', readback_uncertain: 'uncertain',
  rejected: 'failed', save_failed: 'failed', conflict: 'failed', provider_unavailable: 'failed', expired: 'failed', refused: 'failed',
  answered: 'note', clarification: 'note', unsupported: 'note',
};

/** Idempotency fingerprint: a reused clientTurnId must carry the same request parts. */
export function requestFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** At most one buyer turn in flight per session (LIMITS.maxInFlightTurnsPerSession). */
export interface TurnGate {
  busy(sessionId: string): boolean;
  run<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}
export function createTurnGate(): TurnGate {
  const inFlight = new Set<string>();
  return {
    busy: id => inFlight.has(id),
    async run(id, fn) {
      inFlight.add(id);
      try { return await fn(); } finally { inFlight.delete(id); }
    },
  };
}

const uncertainText = (current: number) => `Tailor could not confirm whether this request was saved. The demo now reports version ${current}; reload it before relying on the change.`;
const EXPIRED_TEXT = 'This demo has ended or expired, so Tailor can no longer read or change anything. Start a new demo to continue.';

/**
 * Normalises an agent result so only truthful, bounded tailor turns reach the transcript. A success claim requires the
 * authoritative version to have moved and match the readback; any other claim (which implies "unchanged") is untrue
 * once the version moved. Both become readback_uncertain with uncertain copy.
 */
export function reconcileTurnResult<E, R extends { version: number }, S>(result: TurnResult<E, R, S>, before: number, current: number, fallback: ExecutionLabel): TurnResult<E, R, S> {
  if (!result || !TURN_OUTCOMES.includes(result.outcome)) throw new Error('Agent returned an unknown outcome.');
  const unverifiedCommit = result.outcome === 'committed' && !(current > before && result.evidence?.version === current);
  const movedUnderClaim = current > before && !['committed', 'readback_uncertain', 'expired'].includes(result.outcome);
  if (unverifiedCommit || movedUnderClaim) {
    return {
      outcome: 'readback_uncertain', messages: [{ role: 'tailor', status: 'uncertain', text: uncertainText(current) }],
      steps: Array.isArray(result.steps) ? result.steps.slice(0, 24) : [], execution: result.execution ?? fallback,
    };
  }
  const outcome = result.outcome;
  // Unknown or ended state: the copy is always code-owned here, whatever text the agent result carries.
  const owned: TailorMessage<E>[] | null = outcome === 'readback_uncertain' ? [{ role: 'tailor', status: 'uncertain', text: uncertainText(current) }]
    : outcome === 'expired' ? [{ role: 'tailor', status: 'failed', text: EXPIRED_TEXT }] : null;
  const messages = owned ?? (Array.isArray(result.messages) ? result.messages : []).flatMap(m => {
    const text = typeof m?.text === 'string' ? m.text.trim().slice(0, LIMITS.maxTurnTextChars) : '';
    if (!text) return [];
    let status: ChatStatus = CHAT_STATUSES.includes(m.status) && m.status !== 'pending' ? m.status : 'note';
    if (status === 'applied' && outcome !== 'committed') status = outcome === 'readback_uncertain' ? 'uncertain' : 'failed';
    const turn: TailorMessage<E> = { role: 'tailor', text, status };
    if (status === 'question' && m.clarification) turn.clarification = m.clarification;
    if (['committed', 'answered'].includes(outcome) && m.evidence) turn.evidence = m.evidence;
    return [turn];
  }).slice(0, 8);
  return {
    outcome, messages,
    ...(result.clarification ? { clarification: result.clarification } : {}),
    ...(outcome === 'committed' && result.evidence ? { evidence: result.evidence } : {}),
    steps: Array.isArray(result.steps) ? result.steps.slice(0, 24) : [],
    execution: result.execution ?? fallback,
    ...(outcome === 'committed' && result.story ? { story: result.story } : {}),
  };
}

/** The agent threw before finishing: unchanged means provider_unavailable; a moved version is never called unchanged. */
export function unfinishedTurnResult<E, R, S>(current: number, before: number, execution: ExecutionLabel): TurnResult<E, R, S> {
  const unchanged = current === before;
  return {
    outcome: unchanged ? 'provider_unavailable' : 'readback_uncertain',
    messages: [unchanged
      ? { role: 'tailor', status: 'failed', text: `Tailor could not finish this request, so nothing changed. Version ${current} is still live.` }
      : { role: 'tailor', status: 'uncertain', text: uncertainText(current) }],
    steps: [{ name: 'model', status: 'failed', detail: 'The agent stopped before finishing this turn.' }],
    execution,
  };
}
