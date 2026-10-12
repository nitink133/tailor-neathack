// Tailor runtime quality evaluation. Separate from fictional buyer review forms and from hosted ingestion evidence.
// Exercises the real HTTP/server/store/service with independent GETs and deterministic, explicitly labelled providers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../infrastructure/store.ts';
import { appServer } from '../infrastructure/server.ts';
import { createTelemetry } from '../infrastructure/telemetry.ts';
import { createAgentService } from '../clients/neatlogs/service.ts';
import { createMockProvider } from '../clients/neatlogs/mock-provider.ts';
import { loadKnowledge } from '../clients/neatlogs/knowledge.ts';
import { travelProposalV1 } from '../clients/neatlogs/examples/travel-booking.ts';
import { classifyOfflinePolicy, CAPABILITY_POLICY_SUMMARY, PRODUCT_REMIT } from '../clients/neatlogs/entry-policy.ts';
import { ProviderError } from '../tailor/provider-error.ts';
import { POLICY_VERSION, type PolicyDecision, type PolicyInput, type PolicyOutcome } from '../tailor/policy.ts';
import type { ModelProvider, TurnResponse } from '../clients/neatlogs/agent-contract.ts';
import type { Trace } from '../clients/neatlogs/contracts.ts';
import { POLICY_QUALITY_CASES, RUNTIME_QUALITY_CASES, type RuntimeQualityCase } from './quality-cases.ts';

export const QUALITY_EVAL_VERSION = 'tailor-quality-2026-10-12.1';
export interface CheckResult { name: string; passed: boolean }
export interface QualityCaseResult {
  id: string; passed: boolean; checks: CheckResult[];
  evidence: { outcome: string; versionBefore: number; versionAfter: number; plannerCalls: number; guardCalls: number; publishCalls: number; savedTraceCount: number; independentReadback: boolean; reply: string; steps: string[] }[];
}
export interface PolicyCaseResult { id: string; expected: PolicyOutcome; actual: PolicyOutcome; reason: string; passed: boolean }
export interface QualityReport {
  suite: typeof QUALITY_EVAL_VERSION; policyVersion: string; scope: 'tailor_runtime_quality';
  provider: { mode: 'mock'; classifier: 'offline_heuristic'; liveAccuracy: 'unverified'; tokenUsage: null; knownCostUsd: 0 };
  buyerNeatlogsEvaluations: 'separate_not_run'; passed: boolean;
  policy: { cases: PolicyCaseResult[]; falseBlocks: number; offTopicEscapes: number };
  runtime: QualityCaseResult[];
}

export function evaluatePolicyCases(classify: (input: PolicyInput) => PolicyDecision = classifyOfflinePolicy): QualityReport['policy'] {
  const cases = POLICY_QUALITY_CASES.map(c => {
    const result = classify({ remit: PRODUCT_REMIT, capabilities: CAPABILITY_POLICY_SUMMARY, latestText: c.text, session: {
      hasPublishedState: c.published ?? false,
      pendingClarification: c.choice ? { question: 'Which failure should I show?', choices: [c.choice] } : null,
      resolvedChoice: c.choice ?? null,
    } });
    return { id: c.id, expected: c.expected, actual: result.outcome, reason: result.reason, passed: result.outcome === c.expected };
  });
  const allows = (o: PolicyOutcome) => o === 'allow_product_question' || o === 'allow_demo_action';
  return { cases, falseBlocks: cases.filter(c => allows(c.expected) && !allows(c.actual)).length,
    offTopicEscapes: cases.filter(c => !allows(c.expected) && allows(c.actual)).length };
}

async function evaluateRuntimeCase(spec: RuntimeQualityCase): Promise<QualityCaseResult> {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-quality-'));
  const clock = { now: () => Date.parse('2026-10-12T00:00:00Z') };
  const store = new Store(join(dir, 'quality.sqlite'), { clock, faults: { failSave: () => spec.fault === 'save', failReadback: () => spec.fault === 'readback' } });
  const telemetry = await createTelemetry({ mode: 'captured', secret: 'local-quality-evidence' });
  const mock = createMockProvider();
  let plannerCalls = 0, guardCalls = 0, publishCalls = 0;
  const provider: ModelProvider = {
    ...mock,
    async classifyPolicy(request, signal) {
      guardCalls++;
      if (spec.script === 'guard_invalid') return { decision: { outcome: 'allow_everything', reason: 'trust_me' } as unknown as PolicyDecision, usage: null, latencyMs: 0, costUsd: 0 };
      if (spec.script === 'guard_timeout') throw new ProviderError('timeout', 'Synthetic policy timeout', { retryable: false });
      return mock.classifyPolicy!(request, signal);
    },
    async complete(request, signal) {
      plannerCalls++;
      if (spec.script === 'wrong_workflow') return { action: { type: 'propose', proposal: structuredClone(travelProposalV1), explanation: 'The booking API timed out.' }, usage: null, latencyMs: 0 };
      if (spec.script === 'planner_failure') throw new ProviderError('auth', 'Synthetic planner failure', { retryable: false });
      return mock.complete(request, signal);
    },
  };
  const service = createAgentService();
  const server = appServer(store, {
    devKey: 'local-quality-key', provider, knowledge: loadKnowledge(), telemetry, clock,
    agent: { handleTurn: input => service.handleTurn({ ...input, tools: { ...input.tools,
      async publishScenario(proposal) { publishCalls++; return input.tools.publishScenario(proposal); },
    } }) },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (path: string, method = 'GET', data?: unknown, cookie = '') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: {
      'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-tailor-dev-key': 'local-quality-key', cookie,
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
  };
  const checks: CheckResult[] = [], evidence: QualityCaseResult['evidence'] = [];
  const check = (name: string, passed: boolean) => checks.push({ name, passed });
  try {
    const created = await call('/api/sessions', 'POST', { description: `SYNTHETIC Tailor quality ${spec.id}` });
    if (created.status !== 201) throw new Error(`Cannot create isolated quality session (${created.status})`);
    const id: string = created.data.id, cookie: string = created.cookie;
    let before = await call(`/api/sessions/${id}`, 'GET', undefined, cookie);
    for (let ordinal = 0; ordinal < spec.turns.length; ordinal++) {
      const turn = spec.turns[ordinal]!, expected = turn.expect;
      const start = { plannerCalls, guardCalls, publishCalls };
      const posted = await call(`/api/sessions/${id}/turns`, 'POST', { text: turn.text, clientTurnId: randomUUID(), ...(turn.choiceId ? { choiceId: turn.choiceId } : {}) }, cookie);
      check(`turn${ordinal}:http_ok`, posted.status === 200);
      const result = posted.data as TurnResponse;
      const after = await call(`/api/sessions/${id}`, 'GET', undefined, cookie);
      const list = await call(`/api/sessions/${id}/traces`, 'GET', undefined, cookie);
      const reply = result.messages?.map(m => m.text).join('\n') ?? '';
      const plannerDelta = plannerCalls - start.plannerCalls, publishDelta = publishCalls - start.publishCalls;
      check(`turn${ordinal}:expected_outcome`, expected.outcomes.includes(result.outcome));
      check(`turn${ordinal}:independent_version`, after.data.version === before.data.version + expected.versionDelta);
      if (expected.versionDelta === 0) check(`turn${ordinal}:dataset_unchanged`, JSON.stringify(after.data.dataset) === JSON.stringify(before.data.dataset));
      if (expected.noPlanner) { check(`turn${ordinal}:no_planner`, plannerDelta === 0); check(`turn${ordinal}:no_publish`, publishDelta === 0); }
      if (expected.answerPattern) check(`turn${ordinal}:answer_addresses_requirement`, new RegExp(expected.answerPattern, 'i').test(reply));
      if (expected.forbiddenPattern) check(`turn${ordinal}:truthful_copy`, !new RegExp(expected.forbiddenPattern, 'i').test(reply));
      const active: Trace | undefined = list.data.traces?.find((t: Trace) => t.scenario === list.data.activeScenario);
      let independentReadback = false;
      if (result.outcome === 'committed' && active) {
        const detail = await call(`/api/sessions/${id}/traces/${active.id}`, 'GET', undefined, cookie);
        const actual: Trace = detail.data.trace;
        independentReadback = detail.status === 200 && JSON.stringify(actual) === JSON.stringify(active);
        check(`turn${ordinal}:list_detail_agree`, independentReadback);
        const actualIds = new Set(actual.spans.map(s => s.id));
        check(`turn${ordinal}:reply_citations_exist`, result.messages.every(m => !m.evidence || m.evidence.spanIds.every(s => actualIds.has(s))));
        if (expected.domainTerms) check(`turn${ordinal}:buyer_workflow_preserved`, expected.domainTerms.every(w => `${after.data.story?.domain} ${after.data.story?.summary}`.toLowerCase().includes(w)));
        if (expected.errors !== undefined) check(`turn${ordinal}:expected_error_count`, actual.spans.filter(s => s.status === 'ERROR').length === expected.errors);
        if (expected.blockedPayout) {
          check(`turn${ordinal}:ocr_error_present`, actual.spans.some(s => s.kind === 'TOOL' && s.status === 'ERROR' && /ocr/i.test(s.name)));
          check(`turn${ordinal}:payout_blocked`, actual.spans.some(s => s.kind === 'GUARDRAIL' && s.status === 'ERROR' && /payout/i.test(`${s.name} ${s.error}`)));
          check(`turn${ordinal}:no_travel_leak`, !/travel|booking/i.test(JSON.stringify(after.data.dataset)));
        }
        if (expected.traceCount !== undefined) check(`turn${ordinal}:earlier_examples_preserved`, list.data.total === expected.traceCount);
        if (expected.allStepsOk) check(`turn${ordinal}:quality_distinct_from_execution_failure`, actual.spans.every(s => s.status === 'OK') && actual.outcomeKind === 'degraded');
        const output = actual.output as Record<string, unknown>;
        if (expected.outputQuality === 'unsupported_claim') {
          const source = actual.spans.find(s => s.kind === 'RETRIEVAL')?.output as Record<string, unknown> | undefined;
          check(`turn${ordinal}:unsupported_claim_evidence`, typeof output.answer === 'string' && /supported automatically/.test(output.answer) && /not documented/.test(String(source?.text)));
        }
        if (expected.outputQuality === 'missing_due_date') check(`turn${ordinal}:missing_field_evidence`, output.dueDate === null && actual.spans.some(s => (s.input as Record<string, unknown> | null)?.dueDate === '2026-11-01'));
        if (expected.outputQuality === 'unresolved_support') check(`turn${ordinal}:unresolved_support_evidence`, output.resolved === false && actual.spans.some(s => typeof (s.output as Record<string, unknown> | null)?.nextStep === 'string'));
        for (const spanId of result.evidence?.spanIds ?? []) {
          const containing: Trace | undefined = list.data.traces.find((trace: Trace) => trace.spans.some(s => s.id === spanId));
          const span = containing ? await call(`/api/sessions/${id}/traces/${containing.id}/spans/${spanId}`, 'GET', undefined, cookie) : null;
          check(`turn${ordinal}:independent_span_get`, span?.status === 200 && span.data.span.id === spanId);
        }
      }
      evidence.push({ outcome: result.outcome, versionBefore: before.data.version, versionAfter: after.data.version, plannerCalls: plannerDelta,
        guardCalls: guardCalls - start.guardCalls, publishCalls: publishDelta, savedTraceCount: list.data.total ?? 0, independentReadback,
        reply, steps: result.steps?.map(s => s.name) ?? [] });
      before = after;
    }
    const stranger = await call('/api/sessions', 'POST', { description: 'SYNTHETIC separate quality buyer' });
    const denied = await call(`/api/sessions/${id}`, 'GET', undefined, stranger.cookie);
    check('session_isolation', denied.status === 404);
    const captured = JSON.stringify(telemetry.captured());
    check('telemetry_excludes_buyer_text', spec.turns.every(t => !captured.includes(t.text)));
    check('telemetry_excludes_full_outputs', evidence.every(e => !e.reply || !captured.includes(e.reply)));
    return { id: spec.id, passed: checks.every(c => c.passed), checks, evidence };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await telemetry.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
}

export async function runQualityEvaluations(cases: readonly RuntimeQualityCase[] = RUNTIME_QUALITY_CASES): Promise<QualityReport> {
  const policy = evaluatePolicyCases(), runtime: QualityCaseResult[] = [];
  for (const spec of cases) runtime.push(await evaluateRuntimeCase(spec));
  return { suite: QUALITY_EVAL_VERSION, policyVersion: POLICY_VERSION, scope: 'tailor_runtime_quality',
    provider: { mode: 'mock', classifier: 'offline_heuristic', liveAccuracy: 'unverified', tokenUsage: null, knownCostUsd: 0 },
    buyerNeatlogsEvaluations: 'separate_not_run', passed: policy.cases.every(c => c.passed) && runtime.every(c => c.passed), policy, runtime };
}
