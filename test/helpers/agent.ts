// Test doubles for the agent lane: in-memory SessionTools, a fake KnowledgeIndex, a recording TurnTelemetry and a
// harness that behaves like the backend turn route (appends the buyer turn first, then the tailor turns).
// Network-free; no provider SDK; no credentials.

import {
  CONTRACT_VERSION, FICTIONAL_HOST_PATTERN, LIMITS,
  type AgentAction, type AgentService, type AgentTurnResult, type CapabilityRecord, type Clock, type KnowledgeIndex, type ModelProvider, type PublishResult,
  type ProviderRequest, type ProviderResponse, type ReadbackEvidence, type ScenarioProposal, type SessionSnapshot, type SessionTools, type TurnTelemetry, type ValidationProblem,
} from '../../src/agent-contract.ts';
import type { ChatTurn, Dataset, Span, Story, Trace, TraceList } from '../../src/contracts.ts';
import { createAgentService } from '../../src/agent/service.ts';
import { createMockProvider } from '../../src/agent/mock-provider.ts';

export const SESSION_ID = 'sess-test';

// -------------------------------------------------------------------------------------------------------------------
// Fake knowledge
// -------------------------------------------------------------------------------------------------------------------
function record(partial: Partial<CapabilityRecord> & Pick<CapabilityRecord, 'id' | 'title' | 'behaviour' | 'topics'>): CapabilityRecord {
  return {
    scope: 'official_product', buyerProblem: 'test', limitations: [], prerequisites: [],
    planAvailability: { status: 'unknown', note: 'The plan is not confirmed in the test fixture.' },
    sources: [], exampleQuestions: [],
    demonstration: { level: 'demonstrable', evidence: 'test', cloneSurfaces: [], tools: [] },
    ...partial,
  };
}

export const FAKE_RECORDS: CapabilityRecord[] = [
  record({
    id: 'trace-detail', title: 'Trace detail and spans', behaviour: 'Trace detail shows each step as a span with status, timing and error text. Failing steps show as ERROR.', topics: ['trace', 'span', 'detail', 'detect', 'detection', 'timeline'],
    planAvailability: { status: 'known', plans: ['Free', 'Team'], note: 'Test fixture only.' }, limitations: ['Synthetic data only in this demo.'],
    demonstration: { level: 'demonstrable', evidence: 'ERROR child spans', cloneSurfaces: ['trace detail'], tools: ['publishScenario'] },
  }),
  record({
    id: 'alerts', title: 'Alerts and notifications', behaviour: 'Alert rules can notify a channel such as Slack when a detection fires. This is described here but not wired up in the demo.', topics: ['alert', 'alerts', 'slack', 'notification', 'notify'],
    demonstration: { level: 'explain_only', evidence: 'none', cloneSurfaces: [], tools: [] },
  }),
  record({
    id: 'pricing', title: 'Pricing and plans', behaviour: 'Pricing details for the product are published by the vendor and are not recorded here.', topics: ['pricing', 'price', 'cost', 'plan', 'plans', 'free', 'neatlogs'],
    demonstration: { level: 'explain_only', evidence: 'none', cloneSurfaces: [], tools: [] },
  }),
  record({
    id: 'replay', title: 'Replay', behaviour: 'Replay re-runs a captured trace against a model. It is not available in this demo.', topics: ['replay', 'rerun'],
    demonstration: { level: 'unsupported', evidence: 'none', cloneSurfaces: [], tools: [] },
  }),
];

export function fakeKnowledge(records: CapabilityRecord[] = FAKE_RECORDS): KnowledgeIndex {
  const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return {
    version: 'test-1',
    select(query, max = LIMITS.maxKnowledgeRecordsPerTurn) {
      const q = new Set(tokens(query));
      return records
        .map(r => ({ r, score: [r.id, r.title, ...r.topics].flatMap(tokens).filter(t => q.has(t)).length }))
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(x => x.r);
    },
    get: id => records.find(r => r.id === id),
    all: () => records,
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Telemetry
// -------------------------------------------------------------------------------------------------------------------
export interface RecordingTelemetry extends TurnTelemetry {
  steps: string[];
  events: string[];
  usage: { usage: unknown; model: string | null }[];
}
export function recordingTelemetry(): RecordingTelemetry {
  const steps: string[] = []; const events: string[] = []; const usage: RecordingTelemetry['usage'] = [];
  return {
    turnId: 'turn-test', correlationId: 'corr-test', steps, events, usage,
    async step(name, _attributes, fn) { steps.push(name); return fn(); },
    event(name) { events.push(name); },
    recordUsage(u, model) { usage.push({ usage: u, model }); },
  };
}

// -------------------------------------------------------------------------------------------------------------------
// In-memory SessionTools
// -------------------------------------------------------------------------------------------------------------------
export type PublishScript = 'real' | PublishResult | { throws: string };

export interface StubTools extends SessionTools {
  state: { version: number; dataset: Dataset; story: Story | null };
  /** Per-call overrides, consumed in order; falls back to the real in-memory behaviour. */
  script: PublishScript[];
  calls: { name: string }[];
  proposals: ScenarioProposal[];
  publishCount(): number;
}

/** Minimal-but-real validator (same invariants as test/contract.test.ts). Returns problems instead of asserting. */
export function validateProposal(p: ScenarioProposal): ValidationProblem[] {
  const out: ValidationProblem[] = [];
  const add = (path: string, code: ValidationProblem['code'], message: string) => out.push({ path, code, message });
  if (p.kind !== 'scenario_proposal' || p.contractVersion !== CONTRACT_VERSION) add('', 'SCHEMA', 'kind/contractVersion');
  if (p.traces.length < 1 || p.traces.length > LIMITS.maxTracesPerDataset) add('traces', 'LIMIT', 'trace count');
  if (!p.traces.some(t => t.key === p.activeScenario)) add('activeScenario', 'ACTIVE_SCENARIO_UNKNOWN', 'activeScenario must name a proposed trace');
  if (p.story.assumptions.length > LIMITS.maxAssumptions) add('story', 'LIMIT', 'assumptions');
  p.traces.forEach((t, ti) => {
    const path = `traces[${ti}]`;
    if (t.spans.length < 1 || t.spans.length > LIMITS.maxSpansPerTrace) add(path, 'LIMIT', 'span count');
    if (t.label.length > LIMITS.maxLabelChars) add(path, 'LIMIT', 'label length');
    const roots = t.spans.filter(s => s.parentKey === null);
    if (roots.length === 0) add(path, 'MISSING_ROOT', 'no root'); if (roots.length > 1) add(path, 'MULTIPLE_ROOTS', 'more than one root');
    const root = roots[0];
    if (root && JSON.stringify(root.output) !== JSON.stringify(t.output)) add(path, 'OUTPUT_MISMATCH', 'root output must equal trace output');
    const keys = new Set<string>();
    for (const s of t.spans) {
      const sp = `${path}.spans[${s.key}]`;
      if (keys.has(s.key)) add(sp, 'DUPLICATE_KEY', 'duplicate span key'); keys.add(s.key);
      if (s.parentKey !== null) {
        const parent = t.spans.find(x => x.key === s.parentKey);
        if (!parent) add(sp, 'UNKNOWN_PARENT', `parent ${s.parentKey} missing`);
        else if (s.startMs < parent.startMs || s.startMs + s.durationMs > parent.startMs + parent.durationMs) add(sp, 'TIMING', 'span outside parent timing');
      }
      if ((s.status === 'ERROR') !== (s.error !== null)) add(sp, 'STATUS_ERROR_MISMATCH', 'ERROR iff error text');
      if (s.detection && s.status !== 'ERROR') add(sp, 'DETECTION_WITHOUT_ERROR', 'detection needs ERROR');
      const json = JSON.stringify(s);
      if (/`|<\s*script|child_process|rm\s+-rf/i.test(json)) add(sp, 'EXECUTABLE_CONTENT', 'executable content');
      for (const url of json.match(/https?:\/\/([^/"\s\\]+)/g) ?? []) if (!FICTIONAL_HOST_PATTERN.test(new URL(url).hostname)) add(sp, 'ARBITRARY_URL', url);
    }
    const errors = t.spans.filter(s => s.status === 'ERROR').length;
    if ((t.outcomeKind === 'failure' || t.outcomeKind === 'escalation') && errors < 1) add(path, 'OUTCOME_INCONSISTENT', 'failure/escalation needs an ERROR span');
  });
  return out;
}

export function stubTools(initial?: { version?: number }): StubTools {
  const state: StubTools['state'] = { version: initial?.version ?? 1, dataset: { activeScenario: '', traces: [] }, story: null };
  const calls: { name: string }[] = [];
  const proposals: ScenarioProposal[] = [];
  const script: PublishScript[] = [];
  const toTrace = (p: ScenarioProposal, t: ScenarioProposal['traces'][number]): Trace => {
    const id = `${SESSION_ID}-${t.key}`;
    const spans: Span[] = t.spans.map(s => ({
      id: `${id}-${s.key}`, parentId: s.parentKey === null ? null : `${id}-${s.parentKey}`, name: s.name, kind: s.kind, startMs: s.startMs, durationMs: s.durationMs, status: s.status,
      input: s.input, output: s.output, error: s.error === null ? null : s.error.startsWith('SYNTHETIC:') ? s.error : `SYNTHETIC: ${s.error}`, detection: s.detection,
    }));
    return { id, sessionId: SESSION_ID, scenario: t.key, label: t.label, name: t.name, ingestedAt: '2026-10-11T12:00:00.000Z', status: 'Ready', outcome: t.outcome, outcomeKind: t.outcomeKind, tags: t.tags, input: t.input, output: t.output, spans };
  };
  const readback = (changed: string[]): ReadbackEvidence => {
    const ordered = [...state.dataset.traces].sort((a, b) => Number(changed.includes(b.scenario)) - Number(changed.includes(a.scenario)));
    const traces = ordered.map(t => ({
      id: t.id, key: t.scenario, label: t.label, outcome: t.outcome, outcomeKind: t.outcomeKind, spanCount: t.spans.length,
      rootDurationMs: t.spans.find(s => s.parentId === null)!.durationMs, errorSpanIds: t.spans.filter(s => s.status === 'ERROR').map(s => s.id),
    }));
    const active = traces.find(t => t.key === state.dataset.activeScenario);
    return { version: state.version, traceIds: traces.map(t => t.id), spanIds: active ? [...active.errorSpanIds] : [], activeScenario: state.dataset.activeScenario, traces };
  };
  const tools: StubTools = {
    state, script, calls, proposals,
    publishCount: () => calls.filter(c => c.name === 'publishScenario').length,
    async readSession(): Promise<SessionSnapshot> {
      calls.push({ name: 'readSession' });
      return snapshot(state, []);
    },
    async readTraces(): Promise<TraceList> {
      calls.push({ name: 'readTraces' });
      return { version: state.version, activeScenario: state.dataset.activeScenario, total: state.dataset.traces.length, filtered: state.dataset.traces.length, traces: state.dataset.traces };
    },
    async readTrace(traceId) {
      calls.push({ name: 'readTrace' });
      const trace = state.dataset.traces.find(t => t.id === traceId);
      return trace ? { version: state.version, trace } : null;
    },
    async validateProposal(p) {
      calls.push({ name: 'validateProposal' });
      const problems = validateProposal(p);
      return problems.length ? { ok: false, problems } : { ok: true };
    },
    async publishScenario(p): Promise<PublishResult> {
      calls.push({ name: 'publishScenario' });
      proposals.push(structuredClone(p));
      const next = script.shift() ?? 'real';
      if (next !== 'real') {
        if ('throws' in next) throw new Error(next.throws);
        return next;
      }
      if (p.expectedVersion !== state.version) return { state: 'conflict', currentVersion: state.version };
      const problems = validateProposal(p);
      if (problems.length) return { state: 'rejected', problems, version: state.version };
      const changed = p.traces.map(t => t.key);
      const carried = p.mode === 'edit' ? state.dataset.traces.filter(t => !changed.includes(t.scenario) && !(p.removeTraceKeys ?? []).includes(t.scenario)) : [];
      state.dataset = { activeScenario: p.activeScenario, traces: [...carried, ...p.traces.map(t => toTrace(p, t))] };
      state.story = p.story;
      state.version += 1;
      return { state: 'committed', version: state.version, readback: readback(changed) };
    },
  };
  return tools;
}

function snapshot(state: StubTools['state'], conversation: ChatTurn[]): SessionSnapshot {
  return {
    id: SESSION_ID, version: state.version, conversationVersion: conversation.length, story: state.story, dataset: structuredClone(state.dataset),
    conversation: structuredClone(conversation), state: 'active', expiresAt: '2026-10-11T16:00:00.000Z',
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Counting provider wrapper + harness
// -------------------------------------------------------------------------------------------------------------------
export interface CountingProvider extends ModelProvider { calls: ProviderRequest[]; }
export function countingProvider(inner: ModelProvider = createMockProvider()): CountingProvider {
  const calls: ProviderRequest[] = [];
  return { name: inner.name, model: inner.model, mode: inner.mode, calls, async complete(request, signal) { calls.push(request); return inner.complete(request, signal); } };
}
export function scriptedProvider(next: (request: ProviderRequest, call: number) => AgentAction | Error, label = 'scripted'): CountingProvider {
  const calls: ProviderRequest[] = [];
  return {
    name: label, model: null, mode: 'mock', calls,
    async complete(request): Promise<ProviderResponse> {
      calls.push(request);
      const out = next(request, calls.length);
      if (out instanceof Error) throw out;
      return { action: out, usage: null, latencyMs: 0 };
    },
  };
}

export const fixedClock: Clock = { now: () => 1_760_000_000_000 };

export interface Harness {
  tools: StubTools;
  telemetry: RecordingTelemetry;
  provider: CountingProvider;
  conversation: ChatTurn[];
  say(text: string, opts?: { choiceId?: string; includeBuyerTurn?: boolean; telemetry?: RecordingTelemetry }): Promise<AgentTurnResult>;
}

/** Behaves like the backend route: append the buyer turn, run the agent, append tailor turns, persist the story. */
export function harness(opts: { provider?: CountingProvider; escalationProvider?: ModelProvider; knowledge?: KnowledgeIndex; tools?: StubTools; service?: AgentService } = {}): Harness {
  const tools = opts.tools ?? stubTools();
  const provider = opts.provider ?? countingProvider();
  const knowledge = opts.knowledge ?? fakeKnowledge();
  const service = opts.service ?? createAgentService();
  const telemetry = recordingTelemetry();
  const conversation: ChatTurn[] = [];
  let n = 0;
  const h: Harness = {
    tools, telemetry, provider, conversation,
    async say(text, o = {}) {
      conversation.push({ id: `b${++n}`, role: 'buyer', text, status: 'pending', at: '2026-10-11T12:00:00.000Z' });
      const view = o.includeBuyerTurn === false ? conversation.slice(0, -1) : conversation;
      const session: SessionSnapshot = { ...snapshot(tools.state, view), conversationVersion: conversation.length };
      const turnTelemetry = o.telemetry ?? recordingTelemetry();
      const result = await service.handleTurn({
        session, request: { text, clientTurnId: `ct-${n}`, ...(o.choiceId ? { choiceId: o.choiceId } : {}) }, tools, knowledge, telemetry: turnTelemetry, clock: fixedClock, provider,
        ...(opts.escalationProvider ? { escalationProvider: opts.escalationProvider } : {}),
      });
      for (const step of turnTelemetry.steps) telemetry.steps.push(step);
      const buyer = conversation[conversation.length - 1]!;
      buyer.status = result.outcome === 'committed' ? 'applied' : ['rejected', 'save_failed', 'conflict', 'provider_unavailable'].includes(result.outcome) ? 'failed' : result.outcome === 'readback_uncertain' ? 'uncertain' : 'note';
      for (const m of result.messages) conversation.push({ ...m, id: `t${++n}`, at: '2026-10-11T12:00:01.000Z' });
      if (result.story) tools.state.story = result.story;
      return result;
    },
  };
  return h;
}
