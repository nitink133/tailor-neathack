// Local spend guard for live model calls. Every USD figure here is an ESTIMATE: reported token usage x configured
// per-MTok rates. It can differ from final Anthropic billing, so treat the cap as a safety margin, not an invoice.
//
// - check(): refuses a call BEFORE it is made when spent + worst-case cost of this call would exceed the cap.
// - record(): adds reported usage after a call (also for refusals/truncations, which are billed).
// - The optional ledger keeps the running total across restarts: atomic write (temp file + rename), numbers only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LIMITS, systemClock, type Clock, type ProviderUsage } from '../agent-contract.ts';
import { ProviderError } from './provider-error.ts';

export interface SpendRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache reads/writes fall back to the input rate when absent. */
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/** Defaults for claude-sonnet-5-5 (USD per million tokens). Configurable: rates change, the cap logic does not. */
export const DEFAULT_RATES: SpendRates = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 };

export const SPEND_ESTIMATE_NOTE = 'All USD figures are local estimates from reported token usage and configured rates; they may differ from final Anthropic billing.';

export interface SpendBucket { calls: number; inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadTokens: number; cacheWriteTokens: number; spentUsd: number }

export interface SpendSummary extends SpendBucket {
  capUsd: number;
  remainingUsd: number;
  /** Always true: nothing here is a billing statement. */
  estimated: true;
  note: string;
  byKind: Record<string, SpendBucket>;
  limits: { perCallMaxOutputTokens: number; perTurnMaxCalls: number };
}

export interface SpendGuard {
  /** Worst-case USD for one call: prompt chars / 4 as input tokens plus the full output allowance. */
  worstCaseUsd(promptChars: number, maxOutputTokens: number): number;
  /** Throws ProviderError('spend_cap') when spent + estimatedMaxUsd would exceed the cap. */
  check(estimatedMaxUsd: number): void;
  /** Records reported usage (null = not reported, recorded as a call with no tokens). */
  record(usage: ProviderUsage | null, model: string | null, kind: string): void;
  summary(): SpendSummary;
}

export interface SpendGuardOptions {
  capUsd: number;
  rates?: SpendRates;
  /** e.g. `.local/spend-ledger.json`. Omit for an in-memory guard. */
  ledgerPath?: string;
  clock?: Clock;
  perCallMaxOutputTokens?: number;
  perTurnMaxCalls?: number;
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

interface Ledger { version: 1; total: SpendBucket; byKind: Record<string, SpendBucket>; updatedAt: number }

export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { capUsd, ledgerPath } = options;
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error('capUsd must be a non-negative number');
  // Custom rates replace the defaults wholesale (a missing cache rate then falls back to that custom input rate).
  const rates = options.rates ?? DEFAULT_RATES;
  const clock = options.clock ?? systemClock;
  const perCallMaxOutputTokens = options.perCallMaxOutputTokens ?? LIMITS.maxOutputTokens;
  const perTurnMaxCalls = options.perTurnMaxCalls ?? LIMITS.maxProviderCallsPerTurn;
  let total = emptyBucket();
  let byKind: Record<string, SpendBucket> = {};

  const usdOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
    (u.input * rates.inputPerMTok + u.output * rates.outputPerMTok + u.cacheRead * (rates.cacheReadPerMTok ?? rates.inputPerMTok) + u.cacheWrite * (rates.cacheWritePerMTok ?? rates.inputPerMTok)) / 1_000_000;

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
    const l = parsed as Partial<Ledger> | null;
    const t = l && l.version === 1 ? readBucket(l.total) : null;
    if (!t || !l || typeof l.byKind !== 'object' || l.byKind === null) throw new Error('Spend ledger has an unexpected shape; refusing to guess the running total');
    const kinds: Record<string, SpendBucket> = {};
    for (const [k, v] of Object.entries(l.byKind)) { const b = readBucket(v); if (!b) throw new Error('Spend ledger has an unexpected shape; refusing to guess the running total'); kinds[k] = b; }
    total = t; byKind = kinds;
  }

  function persist(): void {
    if (!ledgerPath) return;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const ledger: Ledger = { version: 1, total, byKind, updatedAt: clock.now() };
    const tmp = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, ledgerPath);
  }

  load();

  return {
    worstCaseUsd(promptChars, maxOutputTokens) {
      const inputTokens = Math.ceil(Math.max(0, promptChars) / 4);
      const outputTokens = Math.min(Math.max(0, maxOutputTokens), perCallMaxOutputTokens);
      return usdOf({ input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 });
    },
    check(estimatedMaxUsd) {
      load();
      if (total.spentUsd + estimatedMaxUsd > capUsd) throw new ProviderError('spend_cap', 'The configured model spend cap would be exceeded by this call');
    },
    record(usage, _model, kind) {
      load();
      const add = (b: SpendBucket) => {
        b.calls += 1;
        if (!usage) return;
        const cacheRead = usage.cacheReadInputTokens ?? 0;
        const cacheWrite = usage.cacheCreationInputTokens ?? 0;
        b.inputTokens += usage.inputTokens; b.outputTokens += usage.outputTokens; b.thinkingTokens += usage.thinkingTokens ?? 0;
        b.cacheReadTokens += cacheRead; b.cacheWriteTokens += cacheWrite;
        b.spentUsd += usdOf({ input: usage.inputTokens, output: usage.outputTokens, cacheRead, cacheWrite });
      };
      add(total);
      add(byKind[kind] ??= emptyBucket());
      persist();
    },
    summary() {
      load();
      return {
        ...total, capUsd, remainingUsd: Math.max(0, capUsd - total.spentUsd), estimated: true, note: SPEND_ESTIMATE_NOTE,
        byKind: structuredClone(byKind), limits: { perCallMaxOutputTokens, perTurnMaxCalls },
      };
    },
  };
}
