// QA Journey Integration Test Matrix (Linear NIT-271).
// WAVE 2 INTEGRATION TEST SUITE.
// This test exercises the end-to-end HTTP seam across the full product matrix.
// Integrated by the orchestrator in wave 2 against the real seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

// Contract imports
import type {
  DemoSession,
  TraceList,
  Trace,
  Span,
} from '../src/contracts.ts';
import {
  type TurnRequest,
  type TurnResponse,
  LIMITS,
} from '../src/agent-contract.ts';
import {
  travelBuyerTurn1,
  travelBuyerTurn2,
  nonProposalRequests,
} from '../src/examples/travel-booking.ts';

// Seam imports to be verified by orchestrator when wave-2 lands:
import { Store } from '../src/store.ts';
import { appServer } from '../src/server.ts';

import { createAgentService } from '../src/agent/service.ts';

import { createProvider } from '../src/agent/provider.ts';

import { loadKnowledge } from '../src/knowledge.ts';

import { createTelemetry } from '../src/telemetry.ts';

interface FakeClock {
  currentTime: number;
  now(): number;
  advance(ms: number): void;
}

function createFakeClock(initialTime = 1_700_000_000_000): FakeClock {
  let currentTime = initialTime;
  return {
    get currentTime() { return currentTime; },
    set currentTime(t: number) { currentTime = t; },
    now: () => currentTime,
    advance: (ms: number) => { currentTime += ms; },
  };
}

interface TestServerHarness {
  server: Server;
  port: number;
  dir: string;
  clock: FakeClock;
  store: Store;
  telemetry: any;
  cleanup: () => Promise<void>;
  call: (
    path: string,
    method?: string,
    data?: unknown,
    cookie?: string,
    idempotencyKey?: string,
    extraHeaders?: Record<string, string>,
  ) => Promise<{ status: number; data: any; cookie: string; headers: Headers }>;
}

async function createHarness(options: {
  clock?: FakeClock;
  faults?: { failSave?: boolean; failReadback?: boolean };
  telemetryMode?: 'captured' | 'disabled';
  /** Delay every agent turn so two HTTP requests genuinely overlap (the mock otherwise finishes in ~ms). */
  agentDelayMs?: number;
} = {}): Promise<TestServerHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-qa-journey-'));
  const dbPath = join(dir, 'test.sqlite');
  const clock = options.clock ?? createFakeClock();

  // Integration (orchestrator): real seam signatures from NIT-273/NIT-272/NIT-270b.
  // Store faults are predicates; the QA boolean flags map to constant predicates.
  const store = new Store(dbPath, {
    clock,
    faults: {
      failSave: () => options.faults?.failSave === true,
      failReadback: () => options.faults?.failReadback === true,
    },
  });

  const knowledge = loadKnowledge();
  const provider = createProvider({ kind: 'mock' });
  const telemetry = await createTelemetry({ mode: options.telemetryMode ?? 'captured', secret: 'test-secret' });
  // Captured spans are exposed as telemetry.captured(); alias for the matrix (k) assertions below.
  (telemetry as any).getCapturedSpans = () => telemetry.captured();
  const realAgent = createAgentService();
  const agentService = options.agentDelayMs
    ? { handleTurn: async (input: Parameters<typeof realAgent.handleTurn>[0]) => { await new Promise(r => setTimeout(r, options.agentDelayMs)); return realAgent.handleTurn(input); } }
    : realAgent;

  const server: Server = appServer(store, { devKey: 'local-review-key', agent: agentService, provider, knowledge, telemetry, clock });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const call = async (
    path: string,
    method = 'GET',
    data?: unknown,
    cookie = '',
    idempotencyKey: string = randomUUID(),
    extraHeaders: Record<string, string> = {},
  ) => {
    const headers: Record<string, string> = {
      cookie,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-tailor-dev-key': 'local-review-key',
      ...extraHeaders,
    };
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const resCookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    let resData: any = null;
    const text = await response.text();
    try {
      resData = text ? JSON.parse(text) : null;
    } catch {
      resData = text;
    }
    return {
      status: response.status,
      data: resData,
      cookie: resCookie,
      headers: response.headers,
    };
  };

  const cleanup = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { server, port, dir, clock, store, telemetry, cleanup, call };
}

// ---------------------------------------------------------------------------
// Matrix (a): Travel journey multi-turn (Turn 1 timeout->retry ok; Turn 2 retry fails)
// ---------------------------------------------------------------------------
test('Matrix (a): Travel journey Turn 1 (timeout->retry ok) and Turn 2 (make retry fail too)', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    // 1. Create a session
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Fictional travel assistant' });
    assert.equal(sessionRes.status, 201);
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;
    assert.equal(sessionRes.data.version, 1);

    // 2. Turn 1: Travel request
    const turn1Res = await call(`/api/sessions/${sid}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(turn1Res.status, 200, `Turn 1 failed: ${JSON.stringify(turn1Res.data)}`);
    const t1: TurnResponse = turn1Res.data;
    assert.equal(t1.outcome, 'committed');
    assert.equal(t1.version, 2);
    assert.ok(t1.evidence, 'evidence must be present on committed turn');
    assert.ok(t1.evidence.traceIds.length >= 1);
    assert.ok(t1.evidence.spanIds.length >= 1);

    // Grounding check: evidence spanIds strictly equal GET /traces/:id span IDs
    const activeTraceId = t1.evidence.traceIds[0]!;
    const traceGet = await call(`/api/sessions/${sid}/traces/${activeTraceId}`, 'GET', undefined, cookie);
    assert.equal(traceGet.status, 200);
    const traceData: Trace = traceGet.data.trace;
    const actualSpanIds = traceData.spans.map(s => s.id).sort();
    assert.deepEqual(t1.evidence.spanIds.sort(), actualSpanIds, 'Evidence spanIds must match independent GET');

    // Explanation text includes the ERROR span name
    const errorSpans = traceData.spans.filter(s => s.status === 'ERROR');
    assert.equal(errorSpans.length, 1);
    const errorSpanName = errorSpans[0]!.name;
    const explanationMessage = t1.messages.find(m => m.role === 'tailor');
    assert.ok(explanationMessage, 'Tailor explanation turn must exist');
    assert.ok(
      explanationMessage.text.includes(errorSpanName) ||
      explanationMessage.text.includes('create_reservation_attempt_1') ||
      explanationMessage.text.includes('timed out'),
      'Explanation must cite the error span name or error description',
    );

    // 3. Turn 2: "Make the retry fail too."
    const turn2Res = await call(`/api/sessions/${sid}/turns`, 'POST', travelBuyerTurn2, cookie);
    assert.equal(turn2Res.status, 200, `Turn 2 failed: ${JSON.stringify(turn2Res.data)}`);
    const t2: TurnResponse = turn2Res.data;
    assert.equal(t2.outcome, 'committed');
    assert.equal(t2.version, 3);

    // Story domain preserved
    const sessionGet = await call(`/api/sessions/${sid}`, 'GET', undefined, cookie);
    const sessionState: DemoSession = sessionGet.data;
    assert.ok(sessionState.story, 'story must exist');
    assert.equal(sessionState.story.domain, 'travel-booking agent');

    // Active scenario changed, 2 ERROR spans, list/detail/span agree
    const listGet = await call(`/api/sessions/${sid}/traces`, 'GET', undefined, cookie);
    assert.equal(listGet.status, 200);
    const traceList: TraceList = listGet.data;
    // Scenario keys are model-chosen (the contract example is a shape reference): assert the active
    // scenario changed and that the follow-up trace is the new active one, retaining the v1 trace.
    assert.notEqual(traceList.activeScenario, t1.evidence!.activeScenario, 'follow-up must activate a new scenario');
    assert.equal(traceList.activeScenario, t2.evidence!.activeScenario, 'list must agree with the turn-2 readback');
    assert.equal(traceList.total, 2, 'Both v1 and v2 traces must be retained');
    assert.ok(traceList.traces.some(t => t.scenario === t1.evidence!.activeScenario), 'v1 trace retained');

    const v2Trace = traceList.traces.find(t => t.scenario === traceList.activeScenario);
    assert.ok(v2Trace, 'v2 trace must be present in traces list');
    const v2Errors = v2Trace.spans.filter(s => s.status === 'ERROR');
    assert.equal(v2Errors.length, 2, 'v2 trace must contain exactly 2 ERROR spans');
    assert.equal(v2Trace.outcomeKind, 'escalation');

    // Individual span GET verification
    const spanGet = await call(`/api/sessions/${sid}/traces/${v2Trace.id}/spans/${v2Errors[0]!.id}`, 'GET', undefined, cookie);
    assert.equal(spanGet.status, 200);
    assert.equal(spanGet.data.span.status, 'ERROR');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (b): Held-out insurance claims triage bot workflow
// ---------------------------------------------------------------------------
test('Matrix (b): Held-out insurance workflow commits, domain mentions insurance/claims, no travel in dataset', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Insurance triage' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const insuranceTurn: TurnRequest = {
      text: 'I am developing an insurance claims triage bot: OCR tool returns garbage, guardrail blocks the payout.',
      clientTurnId: randomUUID(),
    };
    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', insuranceTurn, cookie);
    assert.equal(turnRes.status, 200);
    const res: TurnResponse = turnRes.data;
    assert.equal(res.outcome, 'committed');

    const sessionGet = await call(`/api/sessions/${sid}`, 'GET', undefined, cookie);
    const session: DemoSession = sessionGet.data;
    assert.ok(session.story, 'story should be saved');
    assert.match(session.story.domain.toLowerCase(), /insurance|claim/);

    // Negative assert: no 'travel' or 'booking' anywhere in the dataset
    const datasetStr = JSON.stringify(session.dataset).toLowerCase();
    assert.ok(!datasetStr.includes('travel'), "Dataset must not mention 'travel'");
    assert.ok(!datasetStr.includes('booking'), "Dataset must not mention 'booking'");

    // Check active trace contains OCR error and guardrail span
    const activeTrace = session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario);
    assert.ok(activeTrace);
    const hasError = activeTrace.spans.some(s => s.status === 'ERROR');
    assert.ok(hasError, 'Must have at least one error span');
    const hasGuardrail = activeTrace.spans.some(s => s.kind === 'GUARDRAIL');
    assert.ok(hasGuardrail, 'Must have a guardrail span');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (c): Ambiguous clarification (exactly 3 choices, then choiceId resolves)
// ---------------------------------------------------------------------------
test('Matrix (c): Ambiguous request returns clarification with 3 choices; choiceId resolves', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Clarification demo' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    // Ambiguous turn
    const turn1Res = await call(`/api/sessions/${sid}/turns`, 'POST', nonProposalRequests.ambiguous, cookie);
    assert.equal(turn1Res.status, 200);
    const t1: TurnResponse = turn1Res.data;
    assert.equal(t1.outcome, 'clarification');
    assert.equal(t1.version, 1, 'Dataset version must remain unchanged on clarification');
    assert.ok(t1.clarification, 'Clarification payload must be returned');
    assert.equal(t1.clarification.choices.length, 3, 'Must provide exactly three choices');
    assert.equal(t1.clarification.allowFreeText, true);

    // Choose one choice
    const chosen = t1.clarification.choices[0]!;
    const turn2Res = await call(`/api/sessions/${sid}/turns`, 'POST', {
      text: chosen.label,
      choiceId: chosen.id,
      clientTurnId: randomUUID(),
    }, cookie);
    assert.equal(turn2Res.status, 200);
    const t2: TurnResponse = turn2Res.data;
    assert.ok(t2.outcome === 'committed' || t2.outcome === 'answered');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (d): Knowledge Q&A pricing (answered, unknown/not verified, no state change)
// ---------------------------------------------------------------------------
test('Matrix (d): Knowledge pricing query is answered truthfully with unknown / not verified', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Knowledge Q&A' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const pricingTurn: TurnRequest = {
      text: 'What does Neatlogs cost for enterprise teams?',
      clientTurnId: randomUUID(),
    };
    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', pricingTurn, cookie);
    assert.equal(turnRes.status, 200);
    const t: TurnResponse = turnRes.data;
    assert.equal(t.outcome, 'answered');
    assert.equal(t.version, 1, 'Version must remain unchanged');

    const reply = t.messages.find(m => m.role === 'tailor')?.text.toLowerCase() ?? '';
    assert.ok(
      reply.includes('unknown') || reply.includes('not verified') || reply.includes('not published'),
      "Response text must state pricing is unknown or not verified",
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (e): Slack alert unsupported feature (unsupported outcome, version unchanged)
// ---------------------------------------------------------------------------
test('Matrix (e): Slack alert feature request returns unsupported with version unchanged', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Slack alert test' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', nonProposalRequests.explainOnly, cookie);
    assert.equal(turnRes.status, 200);
    const t: TurnResponse = turnRes.data;
    assert.equal(t.outcome, 'unsupported');
    assert.equal(t.version, 1);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (f): Refusals for injection, code execution, cross-session, real-mutation
// ---------------------------------------------------------------------------
test('Matrix (f): Injection, arbitrary code, cross-session, real-mutation are refused with version unchanged', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Security test' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const attacks = [
      nonProposalRequests.injection,
      nonProposalRequests.arbitraryCode,
      nonProposalRequests.crossSession,
      nonProposalRequests.realMutation,
    ];

    for (const attack of attacks) {
      const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', attack, cookie);
      assert.equal(turnRes.status, 200);
      const t: TurnResponse = turnRes.data;
      assert.equal(t.outcome, 'refused', `Expected 'refused' for turn text: ${attack.text}`);
      assert.equal(t.version, 1, 'Dataset version must remain unchanged on refusal');
    }
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (g): Idempotent replay with same clientTurnId
// ---------------------------------------------------------------------------
test('Matrix (g): Idempotent replay with same clientTurnId returns identical TurnResponse with no version bump', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Idempotency test' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const clientTurnId = randomUUID();
    const turnPayload: TurnRequest = {
      text: travelBuyerTurn1.text,
      clientTurnId,
    };

    const first = await call(`/api/sessions/${sid}/turns`, 'POST', turnPayload, cookie);
    assert.equal(first.status, 200);
    const t1: TurnResponse = first.data;
    assert.equal(t1.outcome, 'committed');
    assert.equal(t1.version, 2);

    // Replay exact same clientTurnId
    const replay = await call(`/api/sessions/${sid}/turns`, 'POST', turnPayload, cookie);
    assert.equal(replay.status, 200);
    const t2: TurnResponse = replay.data;
    assert.equal(t2.turnId, t1.turnId);
    assert.equal(t2.version, 2, 'Version must not bump on replayed clientTurnId');
    assert.equal(t2.conversationVersion, t1.conversationVersion);
    assert.deepEqual(t2.messages, t1.messages);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (h): Two concurrent turns on same session return one 200 and one 409 TURN_IN_FLIGHT
// ---------------------------------------------------------------------------
test('Matrix (h): Concurrent turns on same session return one 200 and one 409 TURN_IN_FLIGHT', async () => {
  const harness = await createHarness({ agentDelayMs: 150 });
  try {
    const { call } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Concurrency test' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const turnA: TurnRequest = { text: 'Turn A proposal', clientTurnId: randomUUID() };
    const turnB: TurnRequest = { text: 'Turn B proposal', clientTurnId: randomUUID() };

    const [resA, resB] = await Promise.all([
      call(`/api/sessions/${sid}/turns`, 'POST', turnA, cookie),
      call(`/api/sessions/${sid}/turns`, 'POST', turnB, cookie),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Expected one 200 success and one 409 conflict');

    const conflictRes = resA.status === 409 ? resA : resB;
    assert.equal(conflictRes.data.error.code, 'TURN_IN_FLIGHT');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (i): Fake clock lifecycle (idle 61m -> 410, lifetime 4h+ -> 410, End demo -> 410, tombstone sweep -> 404)
// ---------------------------------------------------------------------------
test('Matrix (i): Lifecycle transitions: 61m idle 410, 4h lifetime 410, End demo 410, sweep 404', async () => {
  const clock = createFakeClock(1_700_000_000_000);
  const harness = await createHarness({ clock });
  try {
    const { call } = harness;

    // Subtest 1: Idle 61 minutes
    const s1 = await call('/api/sessions', 'POST', { description: 'Idle test' });
    const id1 = s1.data.id;
    const c1 = s1.cookie;

    // Advance 61 minutes without touch
    clock.advance(61 * 60 * 1000);
    const idleGet = await call(`/api/sessions/${id1}`, 'GET', undefined, c1);
    assert.equal(idleGet.status, 410, 'Session idle > 60m must return 410 SESSION_EXPIRED');
    assert.equal(idleGet.data.error.code, 'SESSION_EXPIRED');

    // Sweep deletes tombstone -> 404
    clock.advance(LIMITS.sweepIntervalMs + 1000);
    const sweptGet = await call(`/api/sessions/${id1}`, 'GET', undefined, c1);
    assert.equal(sweptGet.status, 404, 'Swept session must return 404 NOT_FOUND');

    // Subtest 2: Lifetime 4 hours cap despite continuous activity
    const s2 = await call('/api/sessions', 'POST', { description: 'Lifetime test' });
    const id2 = s2.data.id;
    const c2 = s2.cookie;

    // Touch every 30 minutes. expiresAt = createdAt + 4h is the end instant: 3h30 is alive, 4h00 is gone.
    for (let i = 0; i < 8; i++) {
      clock.advance(30 * 60 * 1000);
      const res = await call(`/api/sessions/${id2}`, 'GET', undefined, c2);
      if (i < 7) {
        // Under 4 hours
        assert.equal(res.status, 200, `still alive at ${(i + 1) * 30} min`);
      } else {
        // Reached the 4h lifetime cap despite continuous activity
        assert.equal(res.status, 410, 'Session reaching the 4h lifetime must return 410 SESSION_EXPIRED');
        assert.equal(res.data.error.code, 'SESSION_EXPIRED');
      }
    }

    // Subtest 3: Explicit End demo
    const s3 = await call('/api/sessions', 'POST', { description: 'End demo test' });
    const id3 = s3.data.id;
    const c3 = s3.cookie;

    const endRes = await call(`/api/sessions/${id3}/end`, 'POST', {}, c3);
    assert.equal(endRes.status, 200);

    const afterEndTurn = await call(`/api/sessions/${id3}/turns`, 'POST', { text: 'hi', clientTurnId: randomUUID() }, c3);
    assert.equal(afterEndTurn.status, 410, 'Ended session must return 410 SESSION_ENDED');
    assert.equal(afterEndTurn.data.error.code, 'SESSION_ENDED');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (j): Fault injection (failSave -> save_failed; failReadback -> readback_uncertain)
// ---------------------------------------------------------------------------
test('Matrix (j): Faults: failSave produces save_failed; failReadback produces readback_uncertain', async () => {
  // Fault 1: failSave
  const harnessSaveFail = await createHarness({ faults: { failSave: true } });
  try {
    const { call } = harnessSaveFail;
    const s = await call('/api/sessions', 'POST', { description: 'Save fault test' });
    const sid = s.data.id;
    const cookie = s.cookie;

    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(turnRes.status, 200);
    const t: TurnResponse = turnRes.data;
    assert.equal(t.outcome, 'save_failed');
    assert.equal(t.version, 1, 'Version must remain unchanged on save failure');

    const reply = t.messages.find(m => m.role === 'tailor')?.text.toLowerCase() ?? '';
    assert.ok(reply.includes('unchanged') || reply.includes('failed'), 'Text should mention state is unchanged');

    const checkGet = await call(`/api/sessions/${sid}`, 'GET', undefined, cookie);
    assert.equal(checkGet.data.version, 1);
  } finally {
    await harnessSaveFail.cleanup();
  }

  // Fault 2: failReadback
  const harnessReadbackFail = await createHarness({ faults: { failReadback: true } });
  try {
    const { call } = harnessReadbackFail;
    const s = await call('/api/sessions', 'POST', { description: 'Readback fault test' });
    const sid = s.data.id;
    const cookie = s.cookie;

    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', travelBuyerTurn1, cookie);
    assert.equal(turnRes.status, 200);
    const t: TurnResponse = turnRes.data;
    assert.equal(t.outcome, 'readback_uncertain');

    const reply = t.messages.find(m => m.role === 'tailor')?.text.toLowerCase() ?? '';
    assert.ok(!reply.includes('unchanged'), "Response must NOT claim 'unchanged' when readback is uncertain");
    assert.ok(!reply.includes('saved and verified'), "Response must NOT claim 'saved and verified' when uncertain");

    // Next independent read discovers whether transaction actually committed
    const checkGet = await call(`/api/sessions/${sid}`, 'GET', undefined, cookie);
    assert.ok(checkGet.data.version >= 1);
  } finally {
    await harnessReadbackFail.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (k): Captured telemetry has WORKFLOW span per turn and no raw buyer text/cookie in attributes
// ---------------------------------------------------------------------------
test('Matrix (k): Telemetry records WORKFLOW/turn span; never leaks raw buyer text or cookie in attributes', async () => {
  const harness = await createHarness({ telemetryMode: 'captured' });
  try {
    const { call, telemetry } = harness;
    const sessionRes = await call('/api/sessions', 'POST', { description: 'Telemetry check' });
    const sid = sessionRes.data.id;
    const cookie = sessionRes.cookie;

    const buyerText = 'SECRET_BUYER_PASSPHRASE_12345';
    const turnRes = await call(`/api/sessions/${sid}/turns`, 'POST', {
      text: buyerText,
      clientTurnId: randomUUID(),
    }, cookie);
    assert.equal(turnRes.status, 200);

    // Retrieve captured spans from the local exporter
    const capturedSpans: Array<{ name: string; attributes: Record<string, any> }> =
      typeof telemetry?.getCapturedSpans === 'function' ? telemetry.getCapturedSpans() : [];

    assert.ok(capturedSpans.length > 0, 'Captured telemetry spans must not be empty');
    // The SDK trace root is named `tailor.turn` (kind WORKFLOW) and carries `tailor.step = 'turn'`.
    const hasTurnOrWorkflow = capturedSpans.some(s => s.name === 'tailor.turn' || s.attributes['tailor.step'] === 'turn');
    assert.ok(hasTurnOrWorkflow, 'Must capture a turn or WORKFLOW span');

    // Verify privacy invariants: no attribute contains raw buyer text or cookie
    for (const span of capturedSpans) {
      for (const [key, val] of Object.entries(span.attributes)) {
        const strVal = String(val);
        assert.ok(!strVal.includes(buyerText), `Telemetry attribute '${key}' must not contain raw buyer text`);
        assert.ok(!strVal.includes(cookie), `Telemetry attribute '${key}' must not contain session cookie`);
      }
    }
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Matrix (l): Cross-session cookie returns 404 on traces and turns
// ---------------------------------------------------------------------------
test('Matrix (l): Cross-session cookie returns 404 on session, traces, and turns routes', async () => {
  const harness = await createHarness();
  try {
    const { call } = harness;
    // Session A
    const sA = await call('/api/sessions', 'POST', { description: 'Session A' });
    const idA = sA.data.id;
    const cookieA = sA.cookie;

    // Session B
    const sB = await call('/api/sessions', 'POST', { description: 'Session B' });
    const idB = sB.data.id;
    const cookieB = sB.cookie;

    // Session B attempts to read Session A
    const readAWithB = await call(`/api/sessions/${idA}`, 'GET', undefined, cookieB);
    assert.equal(readAWithB.status, 404);

    // Session B attempts to read Session A traces
    const tracesAWithB = await call(`/api/sessions/${idA}/traces`, 'GET', undefined, cookieB);
    assert.equal(tracesAWithB.status, 404);

    // Session B attempts to submit a turn to Session A
    const turnAWithB = await call(`/api/sessions/${idA}/turns`, 'POST', {
      text: 'Sneaky cross-session turn',
      clientTurnId: randomUUID(),
    }, cookieB);
    assert.equal(turnAWithB.status, 404);
  } finally {
    await harness.cleanup();
  }
});
