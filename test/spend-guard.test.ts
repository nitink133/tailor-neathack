// Spend guard reservations (L4-01 / L1-07), conservative settlement (L4-02) and per-model rates (L4-03).
// Offline: fake clients and temp ledgers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRequest } from '../src/agent-contract.ts';
import { ProviderError, createAnthropicProvider, type MessagesClientLike, type RawMessageLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { MODEL_RATES, createSpendGuard, hasRatesFor } from '../src/tailor/spend.ts';

const KEY = 'placeholder-not-a-key';
const answerWire = { type: 'answer', text: 'ok', clarification: null, proposal: null, explanation: null, traceId: null, spanIds: null, knowledgeIds: [], capabilityId: null, reason: null };
const planRequest = (maxOutputTokens = 4000): ProviderRequest => ({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }], responseSchema: 'agent_action', maxOutputTokens });
const ok = (input: number, output: number): RawMessageLike => ({
  stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output }, content: [{ type: 'text', text: JSON.stringify(answerWire) }],
});

/** A client whose calls stay in flight until `release()`; records how many calls reached it. */
function gatedClient(result: () => RawMessageLike | Error) {
  let started = 0;
  const gates: (() => void)[] = [];
  const client: MessagesClientLike = {
    messages: {
      create: () => { started++; return new Promise((resolve, reject) => gates.push(() => { const r = result(); if (r instanceof Error) reject(r); else resolve(r); })); },
    },
  };
  return { client, started: () => started, release: () => { while (gates.length) gates.shift()!(); } };
}

test('L4-01: six concurrent calls on a $0.10 cap: only the ones whose worst case fits proceed, the rest are spend_cap', async () => {
  const spend = createSpendGuard({ capUsd: 0.10 });
  const g = gatedClient(() => ok(15_000, 4_000)); // ≈ $0.07 actual each
  const p = createAnthropicProvider({ apiKey: KEY, spend, client: g.client, effort: 'low' });
  const worst = spend.worstCaseUsd(0, 4000, 'claude-sonnet-5-5');
  const calls = Array.from({ length: 6 }, () => p.complete(planRequest()).then(() => 'ok', (e: unknown) => (e instanceof ProviderError ? e.kind : 'other')));
  await new Promise(r => setImmediate(r));
  const fits = Math.floor(0.10 / worst);
  assert.ok(fits >= 1 && fits < 6, `fits=${fits}`);
  assert.equal(g.started(), fits, 'only reserved calls reach the client');
  assert.ok(spend.summary().reservedUsd > 0);
  assert.equal(spend.summary().pendingCalls, fits);
  g.release();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes.filter(o => o === 'ok').length, fits);
  assert.equal(outcomes.filter(o => o === 'spend_cap').length, 6 - fits);
  const s = spend.summary();
  assert.equal(s.pendingCalls, 0, 'reservations are settled');
  assert.equal(s.reservedUsd, 0);
  assert.equal(s.calls, fits);
  // Settled to the ACTUAL usage, not the reservation.
  assert.ok(Math.abs(s.spentUsd - fits * (15_000 * 2 + 4_000 * 10) / 1e6) < 1e-9, String(s.spentUsd));
});

test('reservations are released on an unbilled HTTP error and kept conservatively on an unknown-billing error', async () => {
  const spend = createSpendGuard({ capUsd: 1 });
  const http = Object.assign(new Error('rate'), { status: 429 });
  const g1 = gatedClient(() => http);
  // A plain status-bearing error is not an Anthropic.APIError: billing is unknown, so it is kept conservatively.
  const r1 = createAnthropicProvider({ apiKey: KEY, spend, client: g1.client, effort: 'low' }).complete(planRequest()).catch((e: ProviderError) => e.kind);
  await new Promise(r => setImmediate(r));
  assert.equal(spend.summary().pendingCalls, 1);
  g1.release();
  assert.equal(await r1, 'unknown');
  const s = spend.summary();
  assert.deepEqual([s.pendingCalls, s.unreconciledCalls, s.calls], [0, 1, 1]);
  assert.ok(Math.abs(s.unreconciledUsd - spend.worstCaseUsd(0, 4000, 'claude-sonnet-5-5')) < 0.01, 'the worst case is kept');

  // Direct API: release() removes a reservation without charging anything.
  const id = spend.reserve(0.01, { kind: 'plan', model: 'claude-sonnet-5-5' });
  assert.equal(spend.summary().pendingCalls, 1);
  spend.release(id);
  assert.equal(spend.summary().pendingCalls, 0);
  assert.equal(spend.summary().calls, 1, 'a released reservation is not a call');
});

test('reserve/settle: settle(usage) replaces the reservation with the actual cost; settle(null) keeps the worst case as unreconciled; settling twice is a no-op', () => {
  const spend = createSpendGuard({ capUsd: 1 });
  const a = spend.reserve(0.05, { kind: 'plan', model: 'claude-sonnet-5-5' });
  assert.ok(Math.abs(spend.summary().remainingUsd - 0.95) < 1e-12, 'a reservation counts against the cap');
  spend.settle(a, { inputTokens: 1000, outputTokens: 100, thinkingTokens: 60 });
  spend.settle(a, { inputTokens: 1000, outputTokens: 100 });
  let s = spend.summary();
  assert.ok(Math.abs(s.spentUsd - (1000 * 2 + 100 * 10) / 1e6) < 1e-12, 'thinking tokens are inside output tokens and are not billed twice');
  assert.deepEqual([s.calls, s.thinkingTokens, s.pendingCalls, s.unreconciledCalls], [1, 60, 0, 0]);
  const b = spend.reserve(0.05, { kind: 'explain', model: 'claude-sonnet-5-5' });
  spend.settle(b, null);
  s = spend.summary();
  assert.deepEqual([s.calls, s.unreconciledCalls], [2, 1]);
  assert.ok(Math.abs(s.unreconciledUsd - 0.05) < 1e-12);
  assert.ok(Math.abs(s.byKind.explain!.spentUsd - 0.05) < 1e-12);
});

test('sequential enforcement is unchanged: spent + reserved + this call must fit', () => {
  const spend = createSpendGuard({ capUsd: 0.10 });
  const a = spend.reserve(0.06, { kind: 'plan', model: 'claude-sonnet-5-5' });
  assert.throws(() => spend.reserve(0.05, { kind: 'plan', model: 'claude-sonnet-5-5' }), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
  spend.settle(a, { inputTokens: 1000, outputTokens: 1000 }); // $0.012
  const b = spend.reserve(0.05, { kind: 'plan', model: 'claude-sonnet-5-5' });
  spend.settle(b, { inputTokens: 0, outputTokens: 0 });
  assert.throws(() => spend.check(0.09), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
  spend.check(0.08);
});

test('a reservation is persisted BEFORE dispatch; a crash mid-call leaves a pending entry that a restarted guard counts and surfaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-spend-'));
  try {
    const ledgerPath = join(dir, 'spend-ledger.json');
    const spend = createSpendGuard({ capUsd: 0.10, ledgerPath });
    let seenOnDisk: unknown = null;
    const client: MessagesClientLike = { messages: { create: () => { seenOnDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')); return new Promise(() => {}); } } };
    const cancel = new AbortController();
    const inFlight = createAnthropicProvider({ apiKey: KEY, spend, client, effort: 'low' }).complete(planRequest(), cancel.signal).catch((e: ProviderError) => e.kind);
    await new Promise(r => setImmediate(r));
    const onDisk = seenOnDisk as { version: number; pending: { kind: string; usd: number }[] };
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.pending.length, 1, 'the pending reservation was on disk when the request left');
    assert.equal(onDisk.pending[0]!.kind, 'plan');
    // "Restart": a new guard on the same ledger while the first call never settles.
    const restarted = createSpendGuard({ capUsd: 0.10, ledgerPath });
    const s = restarted.summary();
    assert.equal(s.pendingCalls, 1);
    assert.ok(s.unreconciledUsd >= onDisk.pending[0]!.usd - 1e-12);
    assert.ok(s.remainingUsd <= 0.10 - onDisk.pending[0]!.usd + 1e-12, 'the orphaned reservation still counts against the cap');
    assert.throws(() => restarted.reserve(0.10 - onDisk.pending[0]!.usd + 0.001, { kind: 'plan', model: 'claude-sonnet-5-5' }), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
    const raw = readFileSync(ledgerPath, 'utf8');
    assert.ok(!/sk-|api[-_ ]?key|secret|authorization|bearer|hello/i.test(raw), 'numbers and ids only: no secrets, no prompt text');
    // The original process eventually gives up on the call: it is settled conservatively, never as $0.
    cancel.abort();
    assert.equal(await inFlight, 'timeout');
    const after = createSpendGuard({ capUsd: 0.10, ledgerPath }).summary();
    assert.deepEqual([after.pendingCalls, after.unreconciledCalls, after.calls], [0, 1, 1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a version-1 ledger (written before reservations existed) is still read and upgraded on the next write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-spend-'));
  try {
    const ledgerPath = join(dir, 'spend-ledger.json');
    const bucket = { calls: 2, inputTokens: 10, outputTokens: 10, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spentUsd: 0.5 };
    writeFileSync(ledgerPath, JSON.stringify({ version: 1, total: bucket, byKind: { plan: bucket }, updatedAt: 1 }));
    const spend = createSpendGuard({ capUsd: 1, ledgerPath });
    assert.equal(spend.summary().spentUsd, 0.5);
    assert.equal(spend.summary().pendingCalls, 0);
    const id = spend.reserve(0.1, { kind: 'plan', model: 'claude-sonnet-5-5' });
    spend.settle(id, { inputTokens: 0, outputTokens: 0 });
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { version: number; total: { calls: number }; unreconciled: unknown; pending: unknown[] };
    assert.equal(ledger.version, 2);
    assert.equal(ledger.total.calls, 3);
    assert.deepEqual(ledger.pending, []);
    assert.deepEqual(ledger.unreconciled, { calls: 0, usd: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4-03: rates are keyed by model id; unknown models fail closed; Sonnet 5.5 rates match the published price list', async () => {
  assert.equal(hasRatesFor('claude-sonnet-5-5'), true);
  assert.equal(hasRatesFor('claude-imaginary-9'), false);
  assert.deepEqual(MODEL_RATES['claude-sonnet-5-5'], { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.10, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 });
  const spend = createSpendGuard({ capUsd: 10 });
  assert.throws(() => spend.worstCaseUsd(100, 100, 'claude-imaginary-9'), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
  const client: MessagesClientLike = { messages: { create: async () => ok(1, 1) } };
  assert.throws(() => createAnthropicProvider({ apiKey: KEY, spend, client, model: 'claude-imaginary-9' }), /rates/);
  // Explicit rates make any model priceable (operator override).
  const custom = createSpendGuard({ capUsd: 10, rates: { inputPerMTok: 1, outputPerMTok: 1 } });
  assert.equal(custom.worstCaseUsd(4, 1, 'claude-imaginary-9'), 2 / 1e6);
  // Cache reads at the read rate; cache writes at the (conservative) 1-hour write rate because the split is not reported.
  const priced = createSpendGuard({ capUsd: 10 });
  priced.record({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }, 'claude-sonnet-5-5', 'plan');
  assert.ok(Math.abs(priced.summary().spentUsd - (0.10 + 4)) < 1e-9);
});

test('a ledger that cannot be written after a paid call degrades the guard: later reservations are refused (fail closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-spend-'));
  try {
    const ledgerPath = join(dir, 'spend-ledger.json');
    const spend = createSpendGuard({ capUsd: 1, ledgerPath });
    const id = spend.reserve(0.01, { kind: 'plan', model: 'claude-sonnet-5-5' });
    // Make the ledger unreachable: a FILE where the ledger directory should be.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');
    assert.doesNotThrow(() => spend.settle(id, { inputTokens: 1, outputTokens: 1 }), 'settling after a paid call never throws into the provider');
    assert.throws(() => spend.reserve(0.001, { kind: 'plan', model: 'claude-sonnet-5-5' }), (e: unknown) => e instanceof ProviderError && e.kind === 'spend_cap');
    assert.equal(spend.summary().degraded, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
