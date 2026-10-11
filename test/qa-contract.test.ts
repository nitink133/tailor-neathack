// QA contract-level checks (Linear NIT-271). Wave 1.
// Independent of backend/agent/UI implementations: imports ONLY the frozen contract, examples, and docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LIMITS,
  FICTIONAL_HOST_PATTERN,
  type TurnOutcome,
} from '../src/agent-contract.ts';
import {
  travelProposalV1,
  travelProposalV2,
  nonProposalRequests,
} from '../src/clients/neatlogs/examples/travel-booking.ts';

interface EvalItem {
  id: string;
  category: string;
  text: string;
  followUps?: string[];
  expectedOutcome: string;
  expectedChecks: string[];
  notes: string;
}

const VALID_CATEGORIES = new Set([
  'travel_journey',
  'held_out_workflow',
  'unusual_wording',
  'clarification',
  'knowledge_pricing',
  'knowledge_capability',
  'explain_trace',
  'unsupported_feature',
  'injection_buyer_text',
  'injection_tool_output',
  'arbitrary_code',
  'cross_session',
  'real_product_mutation',
  'stale_version_replay',
  'oversize_proposal',
  'concurrency',
  'session_lifecycle',
  'fault_injection',
]);

const ALL_TURN_OUTCOMES: readonly TurnOutcome[] = [
  'answered',
  'clarification',
  'committed',
  'conflict',
  'expired',
  'provider_unavailable',
  'readback_uncertain',
  'refused',
  'rejected',
  'save_failed',
  'unsupported',
] as const;

test('eval-set: at least 16 items, every item has valid category and non-empty expectedChecks', () => {
  const evalSetPath = resolve('docs/nit-269-eval-set.json');
  const raw = readFileSync(evalSetPath, 'utf-8');
  const items: EvalItem[] = JSON.parse(raw);

  assert.ok(Array.isArray(items), 'Eval set must be an array of items');
  assert.ok(items.length >= 16, `Eval set must have at least 16 items, found ${items.length}`);

  const seenIds = new Set<string>();
  for (const item of items) {
    assert.ok(typeof item.id === 'string' && item.id.length > 0, 'item.id must be non-empty string');
    assert.ok(!seenIds.has(item.id), `duplicate item.id: ${item.id}`);
    seenIds.add(item.id);

    assert.ok(
      VALID_CATEGORIES.has(item.category),
      `Item ${item.id} has invalid category '${item.category}'. Valid: ${[...VALID_CATEGORIES].join(', ')}`,
    );

    assert.ok(typeof item.text === 'string' && item.text.trim().length > 0, `Item ${item.id} must have non-empty text`);
    assert.ok(typeof item.expectedOutcome === 'string', `Item ${item.id} must have expectedOutcome`);
    assert.ok(
      ALL_TURN_OUTCOMES.includes(item.expectedOutcome as TurnOutcome),
      `Item ${item.id} expectedOutcome '${item.expectedOutcome}' must be a known TurnOutcome`,
    );

    assert.ok(
      Array.isArray(item.expectedChecks) && item.expectedChecks.length > 0,
      `Item ${item.id} must have non-empty expectedChecks array`,
    );
    for (const check of item.expectedChecks) {
      assert.ok(typeof check === 'string' && check.trim().length > 0, `Item ${item.id} check must be non-empty string`);
    }

    assert.ok(typeof item.notes === 'string' && item.notes.length > 0, `Item ${item.id} must have notes`);
  }
});

test('nonProposalRequests covers required negative categories: injection, code, cross-session, real-mutation, explain-only, ambiguous', () => {
  assert.ok(nonProposalRequests.injection, 'nonProposalRequests must contain injection');
  assert.match(nonProposalRequests.injection.text, /ignore/i);
  assert.match(nonProposalRequests.injection.clientTurnId, /^[0-9a-f-]{36}$/);

  assert.ok(nonProposalRequests.arbitraryCode, 'nonProposalRequests must contain arbitraryCode');
  assert.match(nonProposalRequests.arbitraryCode.text, /require\(|exec|child_process/i);
  assert.match(nonProposalRequests.arbitraryCode.clientTurnId, /^[0-9a-f-]{36}$/);

  assert.ok(nonProposalRequests.crossSession, 'nonProposalRequests must contain crossSession');
  assert.match(nonProposalRequests.crossSession.text, /other buyer|session/i);
  assert.match(nonProposalRequests.crossSession.clientTurnId, /^[0-9a-f-]{36}$/);

  assert.ok(nonProposalRequests.realMutation, 'nonProposalRequests must contain realMutation');
  assert.match(nonProposalRequests.realMutation.text, /real neatlogs|production/i);
  assert.match(nonProposalRequests.realMutation.clientTurnId, /^[0-9a-f-]{36}$/);

  assert.ok(nonProposalRequests.explainOnly, 'nonProposalRequests must contain explainOnly');
  assert.match(nonProposalRequests.explainOnly.text, /slack|alert/i);
  assert.match(nonProposalRequests.explainOnly.clientTurnId, /^[0-9a-f-]{36}$/);

  assert.ok(nonProposalRequests.ambiguous, 'nonProposalRequests must contain ambiguous');
  assert.match(nonProposalRequests.ambiguous.text, /something failing/i);
  assert.match(nonProposalRequests.ambiguous.clientTurnId, /^[0-9a-f-]{36}$/);
});

test('LIMITS invariants: repairs < provider calls, escalations <= 1, idle < lifetime, traces <= 4', () => {
  assert.ok(
    LIMITS.maxRepairsPerTurn < LIMITS.maxProviderCallsPerTurn,
    `maxRepairsPerTurn (${LIMITS.maxRepairsPerTurn}) must be strictly less than maxProviderCallsPerTurn (${LIMITS.maxProviderCallsPerTurn})`,
  );
  assert.ok(
    LIMITS.maxEscalationsPerTurn <= 1,
    `maxEscalationsPerTurn (${LIMITS.maxEscalationsPerTurn}) must be <= 1`,
  );
  assert.ok(
    LIMITS.idleMs < LIMITS.lifetimeMs,
    `idleMs (${LIMITS.idleMs}) must be strictly less than lifetimeMs (${LIMITS.lifetimeMs})`,
  );
  assert.ok(
    LIMITS.maxTracesPerDataset <= 4,
    `maxTracesPerDataset (${LIMITS.maxTracesPerDataset}) must be <= 4`,
  );
});

test('TurnOutcome string set in contract doc matches type and literal list', () => {
  const contractDocPath = resolve('docs/nit-269-contract.md');
  const doc = readFileSync(contractDocPath, 'utf-8');

  // Parse outcome names from the markdown table under "## Outcome states (distinct, tested)"
  const tableSection = doc.split('## Outcome states (distinct, tested)')[1]?.split('##')[0] ?? '';
  const parsedDocOutcomes: string[] = [];
  for (const line of tableSection.split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (match && match[1]) {
      parsedDocOutcomes.push(match[1]);
    }
  }

  // The 11 outcomes explicitly documented in the Outcome states table (orchestrator added `answered` after QA finding #1)
  const expectedDocTableOutcomes: string[] = [
    'answered',
    'committed',
    'rejected',
    'save_failed',
    'readback_uncertain',
    'conflict',
    'unsupported',
    'refused',
    'expired',
    'clarification',
    'provider_unavailable',
  ];

  assert.deepEqual(
    parsedDocOutcomes.sort(),
    expectedDocTableOutcomes.sort(),
    'Parsed outcome states from docs/nit-269-contract.md table must match expected doc outcomes',
  );

  // Every outcome in the doc table must be a member of the TurnOutcome type
  for (const docOutcome of parsedDocOutcomes) {
    assert.ok(
      ALL_TURN_OUTCOMES.includes(docOutcome as TurnOutcome),
      `Doc table outcome '${docOutcome}' must exist in TurnOutcome type`,
    );
  }

  // Every TurnOutcome must be documented in the table (QA finding #1 fixed by adding `answered`).
  const omittedFromDocTable = ALL_TURN_OUTCOMES.filter(o => !parsedDocOutcomes.includes(o));
  assert.deepEqual(omittedFromDocTable, [], 'No TurnOutcome is omitted from the doc table');
});

test('travelProposalV2 keeps v1 trace by not listing it in removeTraceKeys', () => {
  assert.equal(travelProposalV2.mode, 'edit');
  const v1Key = travelProposalV1.traces[0]!.key;
  assert.equal(v1Key, 'booking-timeout-retry-ok');

  // mode='edit' must carry over existing traces unless explicitly listed in removeTraceKeys
  if (travelProposalV2.removeTraceKeys) {
    assert.ok(
      !travelProposalV2.removeTraceKeys.includes(v1Key),
      `travelProposalV2 must not list v1 trace key '${v1Key}' in removeTraceKeys`,
    );
  } else {
    assert.equal(travelProposalV2.removeTraceKeys, undefined);
  }
});

test('FICTIONAL_HOST_PATTERN accepts RFC-reserved/local hosts and rejects commercial/external domains', () => {
  const accepted = [
    'api.partner-hotels.example',
    'localhost',
    'svc.test',
  ];
  for (const host of accepted) {
    assert.ok(FICTIONAL_HOST_PATTERN.test(host), `Expected ${host} to be accepted by FICTIONAL_HOST_PATTERN`);
  }

  const rejected = [
    'api.stripe.com',
    'neatlogs.com',
    'evil.example.com.attacker.net',
  ];
  for (const host of rejected) {
    assert.ok(!FICTIONAL_HOST_PATTERN.test(host), `Expected ${host} to be rejected by FICTIONAL_HOST_PATTERN`);
  }
});
