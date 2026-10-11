// test/qa-live-contract.test.ts
// Offline black-box tests asserting service-level behavior for the live provider baseline (NIT-271 extension).
//
// Exercises the agent service + a scripted fake ModelProvider implementing the live contract
// (including optional explain, ProviderError kinds, cache/thinking usage, validation repair bounds, and telemetry privacy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { DemoSession } from '../src/contracts.ts';
import {
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ExplanationRequest,
  type ExplanationResponse,
  type ProviderUsage,
  type ScenarioProposal,
  type TurnResponse,
  LIMITS,
} from '../src/agent-contract.ts';
import { ProviderError } from '../src/agent/provider-error.ts';
import { travelProposalV1 } from '../src/examples/travel-booking.ts';

import { Store } from '../src/store.ts';
import { appServer } from '../src/server.ts';
import { createAgentService } from '../src/agent/service.ts';
import { loadKnowledge } from '../src/knowledge.ts';
import { createTelemetry, type Telemetry } from '../src/telemetry.ts';

// ---------------------------------------------------------------------------
// Scripted Fake ModelProvider for contract assertions
// ---------------------------------------------------------------------------
interface FakeProvider extends ModelProvider {
  completeCalls: ProviderRequest[];
  explainCalls: ExplanationRequest[];
  onComplete?: (request: ProviderRequest) => Promise<ProviderResponse>;
  onExplain?: (request: ExplanationRequest) => Promise<ExplanationResponse>;
  reset(): void;
}

function createFakeProvider(options: {
  name?: string;
  model?: string | null;
  effort?: string | null;
  onComplete?: (request: ProviderRequest) => Promise<ProviderResponse>;
  onExplain?: (request: ExplanationRequest) => Promise<ExplanationResponse>;
} = {}): FakeProvider {
  const completeCalls: ProviderRequest[] = [];
  const explainCalls: ExplanationRequest[] = [];

  const fake: FakeProvider = {
    name: options.name ?? 'fake-anthropic',
    model: options.model !== undefined ? options.model : 'claude-sonnet-5-5',
    mode: 'live',
    effort: options.effort !== undefined ? options.effort : 'medium',
    completeCalls,
    explainCalls,
    onComplete: options.onComplete,
    onExplain: options.onExplain,
    reset() {
      completeCalls.length = 0;
      explainCalls.length = 0;
    },
    async complete(request: ProviderRequest, _signal?: AbortSignal): Promise<ProviderResponse> {
      completeCalls.push(request);
      if (fake.onComplete) {
        return fake.onComplete(request);
      }
      return {
        action: {
          type: 'answer',
          text: 'Default fake response',
          knowledgeIds: [],
        },
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 10,
      };
    },
    async explain(request: ExplanationRequest, _signal?: AbortSignal): Promise<ExplanationResponse> {
      explainCalls.push(request);
      if (fake.onExplain) {
        return fake.onExplain(request);
      }
      return {
        explanation: {
          text: 'Default fake explanation.',
          spanIds: [],
        },
        usage: { inputTokens: 50, outputTokens: 25 },
        latencyMs: 10,
      };
    },
  };

  return fake;
}

// ---------------------------------------------------------------------------
// Test Server Harness (same composition pattern as test/qa-journey.test.ts)
// ---------------------------------------------------------------------------
interface TestHarness {
  server: Server;
  port: number;
  dir: string;
  store: Store;
  telemetry: Telemetry;
  provider: FakeProvider;
  cleanup: () => Promise<void>;
  call: (
    path: string,
    method?: string,
    data?: unknown,
    cookie?: string,
    idempotencyKey?: string,
  ) => Promise<{ status: number; data: any; cookie: string }>;
}

async function createHarness(fakeProvider: FakeProvider): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-qa-live-contract-'));
  const dbPath = join(dir, 'test.sqlite');

  const store = new Store(dbPath);
  const knowledge = loadKnowledge();
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'test-qa-live-secret' });
  const agent = createAgentService();

  const server = appServer(store, {
    devKey: 'test-qa-dev-key',
    agent,
    provider: fakeProvider,
    knowledge,
    telemetry,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const call = async (
    path: string,
    method = 'GET',
    data?: unknown,
    cookie = '',
    idempotencyKey: string = randomUUID(),
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-tailor-dev-key': 'test-qa-dev-key',
      ...(cookie ? { cookie } : {}),
    };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    const resCookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    let resData: any = null;
    const text = await res.text();
    try {
      resData = text ? JSON.parse(text) : null;
    } catch {
      resData = text;
    }
    return { status: res.status, data: resData, cookie: resCookie };
  };

  const cleanup = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { server, port, dir, store, telemetry, provider: fakeProvider, cleanup, call };
}

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

test('(1) provider complete throws ProviderError auth -> outcome provider_unavailable, version unchanged, mode live, reply has no mock/fallback', async () => {
  const fake = createFakeProvider({
    onComplete: async () => {
      throw new ProviderError('auth', 'Anthropic authentication failed: invalid API key');
    },
  });

  const harness = await createHarness(fake);
  try {
    const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
      description: 'QA live contract - auth failure test',
    });
    assert.strictEqual(typeof session?.id, 'string');
    assert.strictEqual(session.version, 1);

    const turnRes = await harness.call(
      `/api/sessions/${session.id}/turns`,
      'POST',
      {
        text: 'I am building a travel-booking agent.',
        clientTurnId: randomUUID(),
      },
      cookie,
    );

    assert.strictEqual(turnRes.status, 200);
    const data: TurnResponse = turnRes.data;

    // 1. Outcome must be provider_unavailable
    assert.strictEqual(data.outcome, 'provider_unavailable');

    // 2. Dataset version must remain unchanged
    assert.strictEqual(data.version, 1);

    // 3. Execution mode must be reported as live
    assert.strictEqual(data.execution.mode, 'live');
    assert.strictEqual(data.execution.provider, fake.name);

    // 4. Reply text must never mention mock or fallback
    const tailorMsg = data.messages.find((m) => m.role === 'tailor')?.text ?? '';
    assert.ok(tailorMsg.length > 0);
    assert.doesNotMatch(tailorMsg, /\bmock\b/i, 'Reply must not mention mock');
    assert.doesNotMatch(tailorMsg, /\bfallback\b/i, 'Reply must not mention fallback');
  } finally {
    await harness.cleanup();
  }
});

test('(2) kinds rate_limit, timeout, overloaded, spend_cap -> provider_unavailable, version unchanged (spend_cap mentions budget, no numbers)', async () => {
  const kinds = ['rate_limit', 'timeout', 'overloaded', 'spend_cap'] as const;

  for (const kind of kinds) {
    let currentKind = kind;
    const fake = createFakeProvider({
      onComplete: async () => {
        throw new ProviderError(currentKind, `Simulated provider error for ${currentKind}`);
      },
    });

    const harness = await createHarness(fake);
    try {
      const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
        description: `QA live contract - ${kind}`,
      });
      assert.strictEqual(session.version, 1);

      const turnRes = await harness.call(
        `/api/sessions/${session.id}/turns`,
        'POST',
        {
          text: `Trigger ${kind}`,
          clientTurnId: randomUUID(),
        },
        cookie,
      );

      assert.strictEqual(turnRes.status, 200);
      const data: TurnResponse = turnRes.data;

      assert.strictEqual(data.outcome, 'provider_unavailable', `Expected provider_unavailable for kind ${kind}`);
      assert.strictEqual(data.version, 1, `Version must remain unchanged for kind ${kind}`);

      const tailorMsg = data.messages.find((m) => m.role === 'tailor')?.text ?? '';
      assert.ok(tailorMsg.length > 0);

      if (kind === 'spend_cap') {
        // Contract requirement: spend_cap copy mentions budget without exposing numeric dollar figures
        assert.match(
          tailorMsg,
          /\bbudget\b/i,
          `spend_cap copy must mention budget (contract requirement; service may not have landed custom spend_cap message yet: "${tailorMsg}")`,
        );
        assert.doesNotMatch(
          tailorMsg,
          /\b\d+\b/,
          'spend_cap copy must not expose financial numbers or digits',
        );
      }
    } finally {
      await harness.cleanup();
    }
  }
});

test('(3) complete resolves a valid propose action and explain resolves text citing one real span and one fabricated span id -> outcome committed, reply drops the fabricated id, evidence.spanIds ⊆ read-back spans, exactly 2 provider calls', async () => {
  let sessionId = '';
  const fake = createFakeProvider({
    onComplete: async () => ({
      action: {
        type: 'propose',
        proposal: travelProposalV1,
        explanation: 'Planning text for travel proposal',
      },
      usage: { inputTokens: 400, outputTokens: 200 },
      latencyMs: 35,
    }),
    onExplain: async () => {
      // Return grounded text citing the real timeout error span and a fabricated span ID
      const realSpanId = `${sessionId}-booking-timeout-retry-ok-attempt-1`;
      const fabricatedSpanId = 'fabricated-span-not-in-trace-999';
      return {
        explanation: {
          text: `Booking failed on span ${realSpanId} and phantom span ${fabricatedSpanId}.`,
          spanIds: [realSpanId, fabricatedSpanId],
        },
        usage: { inputTokens: 120, outputTokens: 40 },
        latencyMs: 20,
      };
    },
  });

  const harness = await createHarness(fake);
  try {
    const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
      description: 'QA live contract - propose + explain verification',
    });
    sessionId = session.id;

    const turnRes = await harness.call(
      `/api/sessions/${session.id}/turns`,
      'POST',
      {
        text: 'I’m building a travel-booking agent. Show me a booking API timeout followed by a successful retry.',
        clientTurnId: randomUUID(),
      },
      cookie,
    );

    assert.strictEqual(turnRes.status, 200);
    const data: TurnResponse = turnRes.data;

    // 1. Outcome must be committed
    assert.strictEqual(data.outcome, 'committed');
    assert.strictEqual(data.version, 2);

    // 2. Exactly 2 provider calls (1 complete + 1 explain)
    assert.strictEqual(fake.completeCalls.length, 1, 'Expected exactly 1 complete call');
    assert.strictEqual(fake.explainCalls.length, 1, 'Expected exactly 1 explain call');
    const totalCalls = fake.completeCalls.length + fake.explainCalls.length;
    assert.strictEqual(
      totalCalls,
      2,
      `Expected exactly 2 provider calls (complete + explain) but got ${totalCalls}`,
    );

    // 3. Reply drops the fabricated ID
    const tailorMsg = data.messages.find((m) => m.role === 'tailor')?.text ?? '';
    assert.doesNotMatch(tailorMsg, /fabricated-span-not-in-trace-999/, 'Reply must drop fabricated span ID');

    // 4. evidence.spanIds is a subset of actual read-back spans
    assert.ok(data.evidence, 'Evidence must be present on committed turn');
    const savedTrace = harness.store.read(session.id).dataset.traces[0]!;
    const savedSpanIds = new Set(savedTrace.spans.map((s) => s.id));

    for (const sid of data.evidence.spanIds) {
      assert.ok(
        savedSpanIds.has(sid),
        `evidence.spanIds contains ungrounded ID '${sid}' not found in saved trace spans`,
      );
    }
    assert.ok(
      !data.evidence.spanIds.includes('fabricated-span-not-in-trace-999'),
      'evidence.spanIds must not contain fabricated span ID',
    );
  } finally {
    await harness.cleanup();
  }
});

test('(4) explain throws -> still committed with grounded fallback explanation', async () => {
  const fake = createFakeProvider({
    onComplete: async () => ({
      action: {
        type: 'propose',
        proposal: travelProposalV1,
        explanation: 'Planning text for travel proposal',
      },
      usage: { inputTokens: 350, outputTokens: 180 },
      latencyMs: 30,
    }),
    onExplain: async () => {
      throw new ProviderError('timeout', 'Explanation call timed out');
    },
  });

  const harness = await createHarness(fake);
  try {
    const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
      description: 'QA live contract - explain throws fallback test',
    });

    const turnRes = await harness.call(
      `/api/sessions/${session.id}/turns`,
      'POST',
      {
        text: 'I’m building a travel-booking agent.',
        clientTurnId: randomUUID(),
      },
      cookie,
    );

    assert.strictEqual(turnRes.status, 200);
    const data: TurnResponse = turnRes.data;

    // 1. Must still conclude as committed
    assert.strictEqual(data.outcome, 'committed');
    assert.strictEqual(data.version, 2);

    // 2. Evidence must still be present
    assert.ok(data.evidence);
    assert.ok(data.evidence.spanIds.length > 0);

    // 3. Fallback grounded reply must be non-empty
    const tailorMsg = data.messages.find((m) => m.role === 'tailor')?.text ?? '';
    assert.ok(tailorMsg.length > 0, 'Must have grounded explanation even if explain step throws');

    // 4. Assert explain was attempted
    assert.strictEqual(
      fake.explainCalls.length,
      1,
      'Expected provider.explain to be invoked and throw: service has not landed the explain step yet',
    );
  } finally {
    await harness.cleanup();
  }
});

test('(5) a propose that fails validation twice -> rejected with <=3 provider calls', async () => {
  // Invalid proposal: trace with zero spans violates MISSING_ROOT
  const invalidProposal: ScenarioProposal = {
    ...travelProposalV1,
    traces: [
      {
        ...travelProposalV1.traces[0]!,
        spans: [], // Empty spans -> MISSING_ROOT validation problem
      },
    ],
  };

  const fake = createFakeProvider({
    onComplete: async () => ({
      action: {
        type: 'propose',
        proposal: invalidProposal,
        explanation: 'Invalid proposal missing root span',
      },
      usage: { inputTokens: 200, outputTokens: 100 },
      latencyMs: 15,
    }),
  });

  const harness = await createHarness(fake);
  try {
    const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
      description: 'QA live contract - bounded repair test',
    });
    assert.strictEqual(session.version, 1);

    const turnRes = await harness.call(
      `/api/sessions/${session.id}/turns`,
      'POST',
      {
        text: 'Build an invalid scenario',
        clientTurnId: randomUUID(),
      },
      cookie,
    );

    assert.strictEqual(turnRes.status, 200);
    const data: TurnResponse = turnRes.data;

    // 1. Outcome must be rejected after repairs exhausted
    assert.strictEqual(data.outcome, 'rejected');

    // 2. Dataset version must remain unchanged
    assert.strictEqual(data.version, 1);

    // 3. Provider calls must be bounded by <= 3 (LIMITS.maxProviderCallsPerTurn = 3)
    assert.ok(
      fake.completeCalls.length <= LIMITS.maxProviderCallsPerTurn,
      `Expected <= ${LIMITS.maxProviderCallsPerTurn} provider calls, got ${fake.completeCalls.length}`,
    );
    assert.ok(
      fake.completeCalls.length >= 2,
      `Expected at least 2 provider calls (initial + repair attempt), got ${fake.completeCalls.length}`,
    );
  } finally {
    await harness.cleanup();
  }
});

test('(6) usage from the fake with cache + thinking fields reaches telemetry (telemetry.captured() attributes) without any buyer text', async () => {
  const secretBuyerQuery = 'PROPRIETARY_UNRELEASED_FINTECH_ALGO_987654';

  const detailedUsage: ProviderUsage = {
    inputTokens: 1850,
    outputTokens: 620,
    cacheReadInputTokens: 920,
    cacheCreationInputTokens: 310,
    thinkingTokens: 240,
  };

  const fake = createFakeProvider({
    onComplete: async () => ({
      action: {
        type: 'answer',
        text: 'Neatlogs automatically captures agent execution telemetry in workflow spans.',
        knowledgeIds: [],
      },
      usage: detailedUsage,
      latencyMs: 40,
    }),
  });

  const harness = await createHarness(fake);
  try {
    const { cookie, data: session } = await harness.call('/api/sessions', 'POST', {
      description: 'QA live contract - telemetry usage and privacy test',
    });

    const turnRes = await harness.call(
      `/api/sessions/${session.id}/turns`,
      'POST',
      {
        text: `Tell me about failure detection for ${secretBuyerQuery}`,
        clientTurnId: randomUUID(),
      },
      cookie,
    );

    assert.strictEqual(turnRes.status, 200);
    assert.strictEqual(turnRes.data.outcome, 'answered');

    // Check captured telemetry spans
    const capturedSpans = harness.telemetry.captured();
    assert.ok(capturedSpans.length > 0, 'Telemetry must capture spans in captured mode');

    // 1. Verify usage fields reached telemetry attributes
    const hasUsageAttributes = capturedSpans.some((s) => {
      const a = s.attributes;
      return (
        a['tailor.usage.available'] === true &&
        a['tailor.usage.input_tokens'] === 1850 &&
        a['tailor.usage.output_tokens'] === 620 &&
        a['tailor.usage.cache_read_input_tokens'] === 920 &&
        a['tailor.usage.cache_creation_input_tokens'] === 310 &&
        a['tailor.usage.thinking_tokens'] === 240
      );
    });
    assert.ok(
      hasUsageAttributes,
      'Captured spans must contain tailor.usage attributes with input, output, cache read/creation, and thinking tokens',
    );

    // 2. Verify privacy: buyer text must NEVER appear in any telemetry attribute or event
    for (const span of capturedSpans) {
      assert.ok(
        !span.name.includes(secretBuyerQuery),
        `Span name contains buyer text: ${span.name}`,
      );
      for (const [key, value] of Object.entries(span.attributes)) {
        assert.ok(
          !String(value).includes(secretBuyerQuery),
          `Span attribute '${key}' contains buyer text: ${value}`,
        );
      }
      for (const event of span.events) {
        assert.ok(
          !event.name.includes(secretBuyerQuery),
          `Span event name contains buyer text: ${event.name}`,
        );
        for (const [key, value] of Object.entries(event.attributes)) {
          assert.ok(
            !String(value).includes(secretBuyerQuery),
            `Span event attribute '${key}' contains buyer text: ${value}`,
          );
        }
      }
    }
  } finally {
    await harness.cleanup();
  }
});
