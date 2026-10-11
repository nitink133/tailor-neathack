// Local spend guard for live model calls. Every USD figure here is an ESTIMATE: reported token usage x configured
// per-MTok rates. It can differ from final Anthropic billing, so treat the cap as a safety margin, not an invoice.
//
// - reserve(): BEFORE a call, atomically (synchronously, in-process) books the call's worst case against
//   spent + already-reserved, and writes the pending reservation to the ledger before the request leaves.
// - settle(): replaces a reservation with the reported usage. With no usage (timeout, dropped connection, unknown
//   billing) the worst case is KEPT and marked unreconciled: an unaccounted call is never counted as $0.
// - release(): drops a reservation for a call that was certainly not billed (the API answered with an HTTP error).
// - The optional ledger keeps the running total across restarts: atomic write (temp file + rename), numbers only.
//   A reservation left pending by a crash keeps counting against the cap after a restart (it shows as pendingCalls).
//   The ledger never resets by itself; the cap is per ledger file, not per day.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LIMITS, systemClock, type Clock, type ProviderUsage } from '../agent-contract.ts';
import { ProviderError } from './provider-error.ts';

export interface SpendRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache reads/writes fall back to the input rate when absent. Prompt caching is not enabled; the rates are kept ready. */
  cacheReadPerMTok?: number;
  /** 5-minute cache writes. */
  cacheWrite5mPerMTok?: number;
  /** 1-hour cache writes. Usage does not report the split, so cache writes are priced at this (higher) rate when set. */
  cacheWrite1hPerMTok?: number;
}

/** Published rates by model id (USD per million tokens). A model without an entry cannot be priced and is refused. */
export const MODEL_RATES: Readonly<Record<string, SpendRates>> = {
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.10, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 },
};
export const DEFAULT_RATES: SpendRates = MODEL_RATES['claude-sonnet-5-5']!;

export function hasRatesFor(model: string): boolean {
  return Object.hasOwn(MODEL_RATES, model);
}

/** Hard ceiling on output tokens for any single call (thinking + text). Effort-aware ceilings sit at or below it. */
export const PER_CALL_OUTPUT_TOKEN_CEILING = 12_000;

export const SPEND_ESTIMATE_NOTE = 'All USD figures are local estimates from reported token usage and configured rates; they may differ from final Anthropic billing. Unreconciled amounts are worst-case reservations for calls whose usage was never reported.';

export interface SpendBucket { calls: number; inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadTokens: number; cacheWriteTokens: number; spentUsd: number }

export interface SpendSummary extends SpendBucket {
  capUsd: number;
  /** cap - spent - reserved, floored at 0. */
  remainingUsd: number;
  /** Worst-case USD booked for calls in flight (or orphaned by a crash). */
  reservedUsd: number;
  pendingCalls: number;
  /** Settled without reported usage (kept at the worst case). Included in `calls` and `spentUsd`. */
  unreconciledCalls: number;
  /** Worst-case USD not backed by reported usage: unreconciled settlements plus pending reservations. */
  unreconciledUsd: number;
  /** True once the ledger could not be written after a call; every later reservation is refused. */
  degraded: boolean;
  /** Always true: nothing here is a billing statement. */
  estimated: true;
  note: string;
  byKind: Record<string, SpendBucket>;
  limits: { perCallMaxOutputTokens: number; perTurnMaxCalls: number };
}

export interface ReservationMeta { kind: string; model: string | null }

export interface SpendGuard {
  /** Worst-case USD for one call: prompt chars / 4 as input tokens plus the full output allowance, at `model`'s rates. */
  worstCaseUsd(promptChars: number, maxOutputTokens: number, model?: string | null): number;
  /** Books `worstCaseUsd` against the cap and persists it. Throws ProviderError('spend_cap') when it does not fit. */
  reserve(worstCaseUsd: number, meta: ReservationMeta): string;
  /** Replaces the reservation with the reported cost; `null` keeps the worst case and marks it unreconciled. Never throws. */
  settle(reservationId: string, usage: ProviderUsage | null): void;
  /** Drops a reservation for a call that was certainly not billed. Never throws. */
  release(reservationId: string): void;
  /** Non-reserving check: throws ProviderError('spend_cap') when spent + reserved + estimatedMaxUsd would exceed the cap. */
  check(estimatedMaxUsd: number): void;
  /** Records reported usage directly (null = not reported, recorded as a call with no tokens). */
  record(usage: ProviderUsage | null, model: string | null, kind: string): void;
  summary(): SpendSummary;
}

export interface SpendGuardOptions {
  capUsd: number;
  /** Operator override applied to every model. Without it, rates come from MODEL_RATES by model id. */
  rates?: SpendRates;
  /** e.g. `.local/spend-ledger.json`. Omit for an in-memory guard. */
  ledgerPath?: string;
  clock?: Clock;
  perCallMaxOutputTokens?: number;
  perTurnMaxCalls?: number;
}

/** One pending reservation as stored in the ledger. */
export interface PendingReservation { id: string; kind: string; model: string | null; usd: number; at: number }

/** Ledger file shape (version 2). Version 1 files (no `unreconciled`/`pending`) are read and upgraded on the next write. */
export interface SpendLedger {
  version: 2;
  total: SpendBucket;
  byKind: Record<string, SpendBucket>;
  unreconciled: { calls: number; usd: number };
  pending: PendingReservation[];
  updatedAt: number;
}

const emptyBucket = (): SpendBucket => ({ calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spentUsd: 0 });

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function readBucket(v: unknown): SpendBucket | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  const keys = ['calls', 'inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheWriteTokens', 'spentUsd'] as const;
  if (!keys.every(k => isCount(b[k]))) return null;
  return Object.fromEntries(keys.map(k => [k, b[k] as number])) as unknown as SpendBucket;
}
function readPending(v: unknown): PendingReservation | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.kind !== 'string' || !(p.model === null || typeof p.model === 'string') || !isCount(p.usd) || !isCount(p.at)) return null;
  return { id: p.id, kind: p.kind, model: p.model, usd: p.usd, at: p.at };
}

const SHAPE_ERROR = 'Spend ledger has an unexpected shape; refusing to guess the running total';

export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { capUsd, ledgerPath } = options;
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error('capUsd must be a non-negative number');
  const clock = options.clock ?? systemClock;
  const perCallMaxOutputTokens = options.perCallMaxOutputTokens ?? PER_CALL_OUTPUT_TOKEN_CEILING;
  const perTurnMaxCalls = options.perTurnMaxCalls ?? LIMITS.maxProviderCallsPerTurn;
  let total = emptyBucket();
  let byKind: Record<string, SpendBucket> = {};
  let unreconciled = { calls: 0, usd: 0 };
  let pending: PendingReservation[] = [];
  let degraded = false;

  /** Custom rates replace the table wholesale (a missing cache rate then falls back to that custom input rate). */
  function ratesFor(model: string | null | undefined): SpendRates {
    if (options.rates) return options.rates;
    const rates = model ? MODEL_RATES[model] : DEFAULT_RATES;
    if (!rates) throw new ProviderError('spend_cap', 'No spend rates are configured for this model, so its cost cannot be capped');
    return rates;
  }
  const usdOf = (rates: SpendRates, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
    (u.input * rates.inputPerMTok + u.output * rates.outputPerMTok
      + u.cacheRead * (rates.cacheReadPerMTok ?? rates.inputPerMTok)
      + u.cacheWrite * (rates.cacheWrite1hPerMTok ?? rates.cacheWrite5mPerMTok ?? rates.inputPerMTok)) / 1_000_000;
  const pendingUsd = () => pending.reduce((n, p) => n + p.usd, 0);

  /** Re-read the ledger so two guards (or a restart) agree on the running total. A corrupt ledger fails closed. */
  function load(): void {
    if (!ledgerPath) return;
    let raw: string;
    try { raw = readFileSync(ledgerPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Spend ledger could not be read');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Spend ledger is not valid JSON; refusing to guess the running total'); }
    const l = parsed as (Omit<Partial<SpendLedger>, 'version'> & { version?: number }) | null;
    if (!l || (l.version !== 1 && l.version !== 2)) throw new Error(SHAPE_ERROR);
    const t = readBucket(l.total);
    if (!t || typeof l.byKind !== 'object' || l.byKind === null) throw new Error(SHAPE_ERROR);
    const kinds: Record<string, SpendBucket> = {};
    for (const [k, v] of Object.entries(l.byKind)) { const b = readBucket(v); if (!b) throw new Error(SHAPE_ERROR); kinds[k] = b; }
    let u = { calls: 0, usd: 0 };
    let p: PendingReservation[] = [];
    if (l.version === 2) {
      if (!l.unreconciled || !isCount(l.unreconciled.calls) || !isCount(l.unreconciled.usd) || !Array.isArray(l.pending)) throw new Error(SHAPE_ERROR);
      u = { calls: l.unreconciled.calls, usd: l.unreconciled.usd };
      for (const entry of l.pending) { const r = readPending(entry); if (!r) throw new Error(SHAPE_ERROR); p.push(r); }
    }
    total = t; byKind = kinds; unreconciled = u; pending = p;
  }

  function persist(): void {
    if (!ledgerPath) return;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const ledger: SpendLedger = { version: 2, total, byKind, unreconciled, pending, updatedAt: clock.now() };
    const tmp = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, ledgerPath);
  }

  /** After a call has gone out, a ledger failure must not throw into the provider: keep memory, refuse further calls. */
  function afterCall(mutate: () => void): void {
    try { if (!degraded) load(); } catch { degraded = true; }
    mutate();
    try { if (!degraded) persist(); } catch { degraded = true; }
  }

  function addTo(b: SpendBucket, usage: ProviderUsage | null, usd: number): void {
    b.calls += 1;
    b.spentUsd += usd;
    if (!usage) return;
    b.inputTokens += usage.inputTokens; b.outputTokens += usage.outputTokens; b.thinkingTokens += usage.thinkingTokens ?? 0;
    b.cacheReadTokens += usage.cacheReadInputTokens ?? 0; b.cacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
  }
  /** Output tokens are inclusive of thinking (provider-reported total); thinking is tracked, never billed twice. */
  const usageUsd = (usage: ProviderUsage, model: string | null) =>
    usdOf(ratesFor(model), { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens ?? 0, cacheWrite: usage.cacheCreationInputTokens ?? 0 });

  function refuseIfOver(estimatedMaxUsd: number): void {
    if (degraded) throw new ProviderError('spend_cap', 'The spend ledger could not be written, so further model calls are refused');
    if (total.spentUsd + pendingUsd() + estimatedMaxUsd > capUsd) throw new ProviderError('spend_cap', 'The configured model spend cap would be exceeded by this call');
  }

  load();

  return {
    worstCaseUsd(promptChars, maxOutputTokens, model) {
      const inputTokens = Math.ceil(Math.max(0, promptChars) / 4);
      const outputTokens = Math.min(Math.max(0, maxOutputTokens), perCallMaxOutputTokens);
      return usdOf(ratesFor(model ?? null), { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 });
    },
    reserve(worstCaseUsd, meta) {
      if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0) throw new ProviderError('spend_cap', 'The worst-case cost of this call could not be estimated');
      if (!degraded) load();
      refuseIfOver(worstCaseUsd);
      const entry: PendingReservation = { id: randomUUID(), kind: meta.kind, model: meta.model, usd: worstCaseUsd, at: clock.now() };
      pending.push(entry);
      try { persist(); }
      catch {
        pending = pending.filter(p => p.id !== entry.id);
        throw new ProviderError('spend_cap', 'The spend ledger could not be written, so the call was not made');
      }
      return entry.id;
    },
    settle(reservationId, usage) {
      afterCall(() => {
        const entry = pending.find(p => p.id === reservationId);
        if (!entry) return;
        pending = pending.filter(p => p.id !== reservationId);
        let usd = entry.usd;
        let reported = usage;
        if (usage) {
          try { usd = usageUsd(usage, entry.model); } catch { reported = null; }
        }
        if (!reported) { unreconciled.calls += 1; unreconciled.usd += usd; }
        addTo(total, reported, usd);
        addTo(byKind[entry.kind] ??= emptyBucket(), reported, usd);
      });
    },
    release(reservationId) {
      afterCall(() => { pending = pending.filter(p => p.id !== reservationId); });
    },
    check(estimatedMaxUsd) {
      if (!degraded) load();
      refuseIfOver(estimatedMaxUsd);
    },
    record(usage, model, kind) {
      load();
      const usd = usage ? usageUsd(usage, model) : 0;
      addTo(total, usage, usd);
      addTo(byKind[kind] ??= emptyBucket(), usage, usd);
      persist();
    },
    summary() {
      if (!degraded) { try { load(); } catch { degraded = true; } }
      const reservedUsd = pendingUsd();
      return {
        ...total, capUsd, remainingUsd: Math.max(0, capUsd - total.spentUsd - reservedUsd), reservedUsd, pendingCalls: pending.length,
        unreconciledCalls: unreconciled.calls, unreconciledUsd: unreconciled.usd + reservedUsd, degraded,
        estimated: true, note: SPEND_ESTIMATE_NOTE,
        byKind: structuredClone(byKind), limits: { perCallMaxOutputTokens, perTurnMaxCalls },
      };
    },
  };
}
