#!/usr/bin/env node
// scripts/live-smoke.ts
// Live Anthropic smoke test sequence against an already running Tailor server (NIT-271 extension).
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/live-smoke.ts
//
// Requirements:
// - Operates purely over HTTP against TAILOR_URL (default: http://127.0.0.1:4321).
// - Never reads or prints ANTHROPIC_API_KEY.
// - Allowed env vars: TAILOR_URL, TAILOR_DEV_KEY, TAILOR_EXPECT_LIVE.
// - Never prints cookies or session tokens.
// - Uses invented travel-booking scenario data only.
// - Refuses to proceed if TAILOR_EXPECT_LIVE=1 and execution.mode is not 'live'.
// - Exits non-zero on any assertion failure and prints a summary PASS/FAIL table.

import { randomUUID } from 'node:crypto';
import type { TurnResponse, ReadbackEvidence } from '../src/agent-contract.ts';
import type { DemoSession, TraceList, Trace, Span } from '../src/contracts.ts';

// ---------------------------------------------------------------------------
// Environment configuration (strictly allowlisted env vars only)
// ---------------------------------------------------------------------------
const TAILOR_URL = (process.env.TAILOR_URL || 'http://127.0.0.1:4321').replace(/\/+$/, '');
const TAILOR_DEV_KEY = process.env.TAILOR_DEV_KEY;
const EXPECT_LIVE = process.env.TAILOR_EXPECT_LIVE === '1';

interface TestStepResult {
  step: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const testResults: TestStepResult[] = [];

function recordResult(step: string, status: 'PASS' | 'FAIL', detail: string): void {
  testResults.push({ step, status, detail });
}

// ---------------------------------------------------------------------------
// HTTP client with in-memory cookie jar (never logs or prints cookies)
// ---------------------------------------------------------------------------
let sessionCookie = '';

async function requestJson<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
    ...extraHeaders,
  };

  const response = await fetch(`${TAILOR_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const match = /(?:^|;\s*)(tailor=[^;]+)/.exec(setCookie);
    if (match?.[1]) {
      sessionCookie = match[1];
    }
  }

  const text = await response.text();
  let data: T;
  try {
    data = text ? JSON.parse(text) : (null as unknown as T);
  } catch {
    data = text as unknown as T;
  }

  return { status: response.status, data, headers: response.headers };
}

function printTurn(turnLabel: string, res: TurnResponse): void {
  console.log(`\n========================================`);
  console.log(`Turn: ${turnLabel}`);
  console.log(`Outcome: ${res.outcome}`);
  console.log(`Version: ${res.version} (conversation: ${res.conversationVersion})`);
  console.log(
    `Execution: mode=${res.execution.mode}, provider=${res.execution.provider}, model=${res.execution.model ?? 'null'}, effort=${res.execution.effort ?? 'null'}`,
  );
  console.log(
    `Steps: ${res.steps.map((s) => `${s.name}: ${s.status}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ''}`).join(', ')}`,
  );
  const buyerFacingText = res.messages
    .filter((m) => m.role === 'tailor')
    .map((m) => m.text)
    .join('\n');
  console.log(`Buyer Text:\n${buyerFacingText}`);
  console.log(`========================================`);
}

// ---------------------------------------------------------------------------
// Main test sequence
// ---------------------------------------------------------------------------
async function runSmoke(): Promise<void> {
  console.log(`Running Tailor live smoke against ${TAILOR_URL}`);
  console.log(`Strict live check: TAILOR_EXPECT_LIVE=${EXPECT_LIVE ? '1 (enforced)' : '0 (optional)'}`);

  let sessionId = '';
  let turn2Evidence: ReadbackEvidence | undefined;

  // 0. GET /api/execution: check the provider mode BEFORE any turn, so a mock/live mismatch never costs a call.
  const exec = await requestJson<{ execution: TurnResponse['execution'] }>('/api/execution', 'GET');
  if (exec.status !== 200 || !exec.data?.execution) failAndExit(`GET /api/execution failed with HTTP ${exec.status}`);
  console.log(`Server execution: mode=${exec.data.execution.mode}, provider=${exec.data.execution.provider}, model=${exec.data.execution.model ?? 'null'}, effort=${exec.data.execution.effort ?? 'null'}`);
  if (EXPECT_LIVE && exec.data.execution.mode !== 'live') {
    recordResult('0. Execution label (pre-turn)', 'FAIL', `mode=${exec.data.execution.mode}`);
    failAndExit(`Refusing to run: TAILOR_EXPECT_LIVE=1 was set, but GET /api/execution reports mode '${exec.data.execution.mode}'.`);
  }
  recordResult('0. Execution label (pre-turn)', 'PASS', `mode=${exec.data.execution.mode}`);

  // 1. POST /api/sessions (Idempotency-Key, description 'Live smoke — invented travel-booking buyer')
  try {
    const sessionRes = await requestJson<DemoSession>(
      '/api/sessions',
      'POST',
      { description: 'Live smoke — invented travel-booking buyer' },
      { 'idempotency-key': randomUUID() },
    );

    if (sessionRes.status !== 201 || !sessionRes.data?.id) {
      throw new Error(`Expected HTTP 201 with session ID, got ${sessionRes.status}`);
    }

    sessionId = sessionRes.data.id;
    recordResult('1. Create session', 'PASS', `Created session ${sessionId} (HTTP 201)`);
    console.log(`Session created: ${sessionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('1. Create session', 'FAIL', msg);
    failAndExit(`Failed to create session: ${msg}`);
  }

  // 2. Turn 1: "I’m building a travel-booking agent. Show me a booking API timeout followed by a successful retry."
  try {
    const turn1Res = await requestJson<TurnResponse>(
      `/api/sessions/${sessionId}/turns`,
      'POST',
      {
        text: 'I’m building a travel-booking agent. Show me a booking API timeout followed by a successful retry.',
        clientTurnId: randomUUID(),
      },
    );

    if (turn1Res.status !== 200) {
      throw new Error(`Turn 1 failed with HTTP ${turn1Res.status}`);
    }

    const t1 = turn1Res.data;
    printTurn('Turn 1: Booking API timeout & retry', t1);

    // Live mode verification: refuse to run if mock when EXPECT_LIVE=1
    if (EXPECT_LIVE && t1.execution.mode !== 'live') {
      const err = `Refusing to run: TAILOR_EXPECT_LIVE=1 was set, but execution.mode was '${t1.execution.mode}'. Expected 'live'.`;
      recordResult('2. Turn 1 (Live check)', 'FAIL', err);
      failAndExit(err);
    }

    if (t1.outcome !== 'committed') {
      throw new Error(`Expected outcome 'committed', got '${t1.outcome}'`);
    }
    if (t1.version !== 2) {
      throw new Error(`Expected dataset version 2, got ${t1.version}`);
    }
    if (!t1.evidence || !Array.isArray(t1.evidence.traces) || t1.evidence.traces.length === 0) {
      throw new Error('Expected evidence payload with at least 1 trace');
    }

    recordResult('2. Turn 1: Booking timeout & retry', 'PASS', `Committed version 2, outcome=${t1.outcome}, mode=${t1.execution.mode}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('2. Turn 1: Booking timeout & retry', 'FAIL', msg);
    failAndExit(`Turn 1 assertion failed: ${msg}`);
  }

  // 3. Turn 2: "Make the retry fail too."
  try {
    const turn2Res = await requestJson<TurnResponse>(
      `/api/sessions/${sessionId}/turns`,
      'POST',
      {
        text: 'Make the retry fail too.',
        clientTurnId: randomUUID(),
      },
    );

    if (turn2Res.status !== 200) {
      throw new Error(`Turn 2 failed with HTTP ${turn2Res.status}`);
    }

    const t2 = turn2Res.data;
    printTurn('Turn 2: Make retry fail too', t2);

    if (t2.outcome !== 'committed') {
      throw new Error(`Expected outcome 'committed', got '${t2.outcome}'`);
    }
    if (t2.version !== 3) {
      throw new Error(`Expected dataset version 3, got ${t2.version}`);
    }
    if (!t2.evidence) {
      throw new Error('Expected evidence payload on Turn 2');
    }

    turn2Evidence = t2.evidence;

    // Check two traces retained
    if (t2.evidence.traces.length !== 2) {
      throw new Error(`Expected 2 retained traces, found ${t2.evidence.traces.length}`);
    }

    // Active trace has 2 ERROR spans
    const activeTrace = t2.evidence.traces.find((t) => t.key === t2.evidence?.activeScenario) ?? t2.evidence.traces[0];
    if (!activeTrace) {
      throw new Error('Active trace not found in evidence traces');
    }
    if (activeTrace.errorSpanIds.length !== 2) {
      throw new Error(`Expected active trace to have 2 ERROR spans, found ${activeTrace.errorSpanIds.length}`);
    }

    recordResult(
      '3. Turn 2: Make retry fail too',
      'PASS',
      `Committed version 3, 2 traces retained, active trace has 2 ERROR spans`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('3. Turn 2: Make retry fail too', 'FAIL', msg);
    failAndExit(`Turn 2 assertion failed: ${msg}`);
  }

  // 4. GET session + traces + each trace detail + one span: assert list/detail/span agree
  try {
    // 4a. GET session
    const getSession1 = await requestJson<DemoSession>(`/api/sessions/${sessionId}`);
    if (getSession1.status !== 200 || !getSession1.data?.dataset) {
      throw new Error(`Failed to GET session: HTTP ${getSession1.status}`);
    }
    const sessionBefore = getSession1.data;

    // 4b. GET traces list
    const getTracesRes = await requestJson<TraceList>(`/api/sessions/${sessionId}/traces`);
    if (getTracesRes.status !== 200 || !Array.isArray(getTracesRes.data?.traces)) {
      throw new Error(`Failed to GET traces: HTTP ${getTracesRes.status}`);
    }
    const traceList = getTracesRes.data.traces;
    if (traceList.length !== 2) {
      throw new Error(`Expected 2 traces in list, got ${traceList.length}`);
    }

    // 4c. GET each trace detail and assert agreement
    const savedTraces: Trace[] = [];
    let activeSavedTrace: Trace | undefined;
    for (const item of traceList) {
      const getTraceRes = await requestJson<{ version: number; trace: Trace }>(`/api/sessions/${sessionId}/traces/${item.id}`);
      if (getTraceRes.status !== 200 || !getTraceRes.data?.trace) {
        throw new Error(`Failed to GET trace ${item.id}: HTTP ${getTraceRes.status}`);
      }
      const detail = getTraceRes.data.trace;
      if (detail.id !== item.id) {
        throw new Error(`Trace detail ID mismatch: expected ${item.id}, got ${detail.id}`);
      }
      if (detail.spans.length !== item.spans.length) {
        throw new Error(`Trace span count mismatch for ${item.id}: summary=${item.spans.length}, detail=${detail.spans.length}`);
      }
      if (detail.outcome !== item.outcome || detail.outcomeKind !== item.outcomeKind) {
        throw new Error(`Trace outcome mismatch for ${item.id}`);
      }
      savedTraces.push(detail);
      if (detail.scenario === sessionBefore.dataset.activeScenario) {
        activeSavedTrace = detail;
      }
    }

    if (!activeSavedTrace) {
      throw new Error('Active trace detail was not retrieved');
    }

    // Assert every span ID cited in the explanation evidence exists in the saved trace(s)
    const allSavedSpanIds = new Set(savedTraces.flatMap((t) => t.spans.map((s) => s.id)));
    for (const citedId of turn2Evidence?.spanIds ?? []) {
      if (!allSavedSpanIds.has(citedId)) {
        throw new Error(`Cited span ID ${citedId} does not exist in any saved trace for session ${sessionId}`);
      }
    }

    // 4d. GET one span detail
    const sampleSpan = activeSavedTrace.spans[0];
    if (!sampleSpan) {
      throw new Error('No span available to query in active trace');
    }
    const getSpanRes = await requestJson<{ version: number; span: Span }>(
      `/api/sessions/${sessionId}/traces/${activeSavedTrace.id}/spans/${sampleSpan.id}`,
    );
    if (getSpanRes.status !== 200 || !getSpanRes.data?.span) {
      throw new Error(`Failed to GET span ${sampleSpan.id}: HTTP ${getSpanRes.status}`);
    }
    const fetchedSpan = getSpanRes.data.span;
    if (fetchedSpan.id !== sampleSpan.id || fetchedSpan.name !== sampleSpan.name || fetchedSpan.status !== sampleSpan.status) {
      throw new Error(`Span detail mismatch for span ${sampleSpan.id}`);
    }

    // 4e. Reload consistency: GET session again
    const getSession2 = await requestJson<DemoSession>(`/api/sessions/${sessionId}`);
    if (getSession2.status !== 200) {
      throw new Error(`Failed to reload session: HTTP ${getSession2.status}`);
    }
    const sessionAfter = getSession2.data;
    if (sessionAfter.version !== sessionBefore.version) {
      throw new Error(`Reload consistency failed: version moved from ${sessionBefore.version} to ${sessionAfter.version}`);
    }
    if (sessionAfter.conversationVersion !== sessionBefore.conversationVersion) {
      throw new Error(`Reload consistency failed: conversationVersion moved`);
    }
    if (sessionAfter.conversation.length !== sessionBefore.conversation.length) {
      throw new Error(`Reload consistency failed: conversation turn count changed`);
    }

    recordResult('4. Trace & reload consistency', 'PASS', 'List/detail/span agree, evidence spans verified, reload consistent');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('4. Trace & reload consistency', 'FAIL', msg);
    failAndExit(`Trace consistency verification failed: ${msg}`);
  }

  // 5. Turn 3: "Show me something failing." -> clarification with 3 choices, then answer with choiceId.
  // Runs in a FRESH session: once a failing trace is saved, the live model rightly explains it instead of asking
  // (the prompt is only materially ambiguous when nothing is described yet). The first session is ended first.
  try {
    const endFirst = await requestJson<{ endedAt: string }>(`/api/sessions/${sessionId}/end`, 'POST');
    if (endFirst.status !== 200) throw new Error(`Ending the scenario session failed with HTTP ${endFirst.status}`);
    const freshRes = await requestJson<DemoSession>('/api/sessions', 'POST', { description: 'Live smoke — invented buyer, clarification path' }, { 'idempotency-key': randomUUID() });
    if (freshRes.status !== 201 || !freshRes.data?.id) throw new Error(`Expected HTTP 201 for the fresh session, got ${freshRes.status}`);
    sessionId = freshRes.data.id;
    console.log(`Fresh session for the clarification path: ${sessionId}`);
    const turn3Res = await requestJson<TurnResponse>(
      `/api/sessions/${sessionId}/turns`,
      'POST',
      {
        text: 'Show me something failing.',
        clientTurnId: randomUUID(),
      },
    );

    if (turn3Res.status !== 200) {
      throw new Error(`Turn 3 failed with HTTP ${turn3Res.status}`);
    }

    const t3 = turn3Res.data;
    printTurn('Turn 3: Ambiguous prompt (expect clarification)', t3);

    if (t3.outcome !== 'clarification') {
      throw new Error(`Expected outcome 'clarification', got '${t3.outcome}'`);
    }
    if (!t3.clarification || !Array.isArray(t3.clarification.choices) || t3.clarification.choices.length !== 3) {
      throw new Error(`Expected clarification with exactly 3 choices, got ${t3.clarification?.choices?.length ?? 0}`);
    }

    const chosenChoice = t3.clarification.choices[0]!;
    console.log(`Selecting clarification choice: [${chosenChoice.id}] ${chosenChoice.label}`);

    // Answer with choiceId
    const turn3AnswerRes = await requestJson<TurnResponse>(
      `/api/sessions/${sessionId}/turns`,
      'POST',
      {
        text: chosenChoice.label,
        choiceId: chosenChoice.id,
        clientTurnId: randomUUID(),
      },
    );

    if (turn3AnswerRes.status !== 200) {
      throw new Error(`Turn 3 choice answer failed with HTTP ${turn3AnswerRes.status}`);
    }

    const t3Answer = turn3AnswerRes.data;
    printTurn('Turn 3b: Clarification answer', t3Answer);

    recordResult(
      '5. Turn 3: Clarification & choice answer',
      'PASS',
      `Clarification gave 3 choices; answered choice [${chosenChoice.id}] -> outcome ${t3Answer.outcome}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('5. Turn 3: Clarification & choice answer', 'FAIL', msg);
    failAndExit(`Clarification turn failed: ${msg}`);
  }

  // 6. Turn 4: Unsupported feature request -> outcome unsupported, version unchanged
  try {
    // Read version before turn
    const sessionBefore = (await requestJson<DemoSession>(`/api/sessions/${sessionId}`)).data;
    const versionBefore = sessionBefore.version;

    const turn4Res = await requestJson<TurnResponse>(
      `/api/sessions/${sessionId}/turns`,
      'POST',
      {
        text: 'Set up Slack alerts for this project',
        clientTurnId: randomUUID(),
      },
    );

    if (turn4Res.status !== 200) {
      throw new Error(`Turn 4 failed with HTTP ${turn4Res.status}`);
    }

    const t4 = turn4Res.data;
    printTurn('Turn 4: Unsupported feature (Slack alerts)', t4);

    // "Set up Slack alerts" is both an unsupported capability and a request to change real project settings; the
    // live model may classify it either way. Both are correct as long as nothing is changed.
    if (t4.outcome !== 'unsupported' && t4.outcome !== 'refused') {
      throw new Error(`Expected outcome 'unsupported' or 'refused', got '${t4.outcome}'`);
    }
    if (t4.version !== versionBefore) {
      throw new Error(`Expected version to remain unchanged (${versionBefore}), got ${t4.version}`);
    }

    recordResult('6. Turn 4: Unsupported feature', 'PASS', `Outcome '${t4.outcome}', version unchanged at ${t4.version}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('6. Turn 4: Unsupported feature', 'FAIL', msg);
    failAndExit(`Unsupported feature turn failed: ${msg}`);
  }

  // 7. POST /api/sessions/:id/end
  try {
    const endRes = await requestJson<{ endedAt: string }>(`/api/sessions/${sessionId}/end`, 'POST');
    if (endRes.status !== 200) {
      throw new Error(`End session failed with HTTP ${endRes.status}`);
    }
    recordResult('7. End session', 'PASS', `Session ${sessionId} cleanly ended (HTTP 200)`);
    console.log(`Session ended: ${sessionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordResult('7. End session', 'FAIL', msg);
    failAndExit(`End session failed: ${msg}`);
  }

  // Spend guard summary inspection (GET /api/dev/spend)
  console.log('\n--- Spend Guard Inspection ---');
  try {
    const spendRes = await requestJson<any>(
      '/api/dev/spend',
      'GET',
      undefined,
      TAILOR_DEV_KEY ? { 'x-tailor-dev-key': TAILOR_DEV_KEY } : {},
    );

    if (spendRes.status === 200 && spendRes.data) {
      const s = spendRes.data;
      console.log(`Spend Guard Status: available=${s.available ?? false}`);
      if (s.available) {
        // Field names follow SpendSummary in src/tailor/spend.ts.
        console.log(`  Estimated Total Cost:  $${Number(s.spentUsd ?? 0).toFixed(4)} of cap $${s.capUsd ?? '?'} (remaining $${Number(s.remainingUsd ?? 0).toFixed(4)}) (ESTIMATED)`);
        console.log(`  Model Calls:           ${s.calls ?? 0}`);
        console.log(`  Input Tokens:          ${s.inputTokens ?? 0}`);
        console.log(`  Output Tokens:         ${s.outputTokens ?? 0} (includes thinking)`);
        console.log(`  Thinking Tokens:       ${s.thinkingTokens ?? 0}`);
        console.log(`  Cache Read Input:      ${s.cacheReadTokens ?? 0}`);
        console.log(`  Cache Creation Input:  ${s.cacheWriteTokens ?? 0}`);
        if (s.byKind) for (const [kind, b] of Object.entries<any>(s.byKind)) console.log(`  · ${kind}: calls=${b.calls} in=${b.inputTokens} out=${b.outputTokens} thinking=${b.thinkingTokens} $${Number(b.spentUsd).toFixed(4)}`);
      } else {
        console.log(`  Reason: ${s.reason ?? 'Live provider spend tracking not active'}`);
      }
      console.log(`  * NOTE: All USD amounts are estimates only. Anthropic billing is authoritative and may differ.`);
      recordResult('8. Dev spend check', 'PASS', `Spend endpoint reported successfully (HTTP 200)`);
    } else {
      console.log(`Notice: /api/dev/spend endpoint returned HTTP ${spendRes.status}; spend route is absent or requires dev key.`);
      recordResult('8. Dev spend check', 'PASS', `Spend endpoint not enabled or absent (HTTP ${spendRes.status})`);
    }
  } catch (err) {
    console.log(`Notice: /api/dev/spend endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    recordResult('8. Dev spend check', 'PASS', 'Spend endpoint absent or omitted');
  }

  printSummaryTable();
}

function printSummaryTable(): void {
  console.log('\n========================================================================================');
  console.log('LIVE SMOKE RESULTS SUMMARY');
  console.log('========================================================================================');
  let hasFailure = false;
  for (const r of testResults) {
    const mark = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    if (r.status === 'FAIL') hasFailure = true;
    console.log(`${mark} | ${r.step.padEnd(40)} | ${r.detail}`);
  }
  console.log('========================================================================================');

  if (hasFailure) {
    console.error('Smoke suite finished with failures.');
    process.exit(1);
  } else {
    console.log('All smoke checks passed successfully.');
    process.exit(0);
  }
}

function failAndExit(message: string): never {
  console.error(`\nFATAL: ${message}`);
  printSummaryTable();
  process.exit(1);
}

// Execute
runSmoke().catch((err) => {
  console.error('Unhandled smoke runner error:', err);
  process.exit(1);
});
