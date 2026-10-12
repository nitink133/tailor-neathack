import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSpendGuard, DEFAULT_RATES, hasRatesFor } from '../src/tailor/spend.ts';
const HAIKU = 'claude-haiku-5-5';
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('Haiku threshold counts uncached input plus both cache categories; the entire call changes tier above 100000', () => {
  const spend = createSpendGuard({ capUsd: 1 });
  assert.equal(hasRatesFor(HAIKU), true);
  const boundary = { inputTokens: 60_000, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 10_000, outputTokens: 1000, thinkingTokens: 500 };
  near(spend.priceUsd!(boundary, HAIKU), (60_000 * .1 + 30_000 * .01 + 10_000 * .2 + 1000 * .5) / 1e6);
  near(spend.priceUsd!({ ...boundary, cacheReadInputTokens: 30_001 }, HAIKU), (60_000 * .5 + 30_001 * .05 + 10_000 * 1 + 1000 * 2.5) / 1e6);
  near(spend.priceUsd!({ ...boundary, cacheCreationInputTokens: 10_001 }, HAIKU), (60_000 * .5 + 30_000 * .05 + 10_001 * 1 + 1000 * 2.5) / 1e6);
  // Thinking is already included in output; unknown TTL is conservatively billed at 1h.
  near(spend.priceUsd!({ inputTokens: 0, outputTokens: 1000, thinkingTokens: 1000, cacheCreationInputTokens: 1000 }, HAIKU), .0007);
});

test('reservation bounds include framing/schema overhead in tier selection and fail before an unaffordable high-tier call', () => {
  const spend = createSpendGuard({ capUsd: .04 });
  near(spend.worstCaseUsd(99_400, 1000, HAIKU, 600), .0105);
  const high = spend.worstCaseUsd(99_401, 1000, HAIKU, 600);
  near(high, .0525005);
  assert.throws(() => spend.reserve(high, { model: HAIKU, kind: 'plan' }), /cap/);
  assert.equal(spend.summary().pendingCalls, 0);
  near(spend.worstCaseUsd(100_001, 1000, 'claude-sonnet-5-5'), (100_001 * 2 + 1000 * 10) / 1e6);
  assert.deepEqual(DEFAULT_RATES, { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: .1, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 });
  assert.throws(() => spend.worstCaseUsd(100, 100, 'claude-unknown-9'), /rates/);
});

test('unreported or numerically invalid Haiku usage retains the reservation across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-haiku-price-'));
  try {
    const ledgerPath = join(dir, 'ledger.json'), spend = createSpendGuard({ capUsd: 1, ledgerPath });
    const worst = spend.worstCaseUsd(100_001, 1000, HAIKU);
    const r = spend.reserve(worst, { model: HAIKU, kind: 'plan' });
    const invalid = { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadInputTokens: 1, outputTokens: 0 };
    assert.equal(spend.priceUsd!(invalid, HAIKU), null);
    spend.settle(r, invalid);
    const after = createSpendGuard({ capUsd: 1, ledgerPath }).summary();
    near(after.spentUsd, worst); near(after.unreconciledUsd, worst);
    assert.equal(after.unreconciledCalls, 1);
    assert.equal(after.inputTokens, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
