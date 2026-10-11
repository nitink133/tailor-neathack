// Shared backend test helpers (NIT-273): fake clock, stub agent/provider/knowledge, temp stores and servers.
// Model-free and network-free.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AgentService, AgentTurnInput, AgentTurnResult, Clock, KnowledgeIndex, ModelProvider, PublishResult } from '../../src/agent-contract.ts';
import { travelProposalV1, travelProposalV2 } from '../../src/clients/neatlogs/examples/travel-booking.ts';
import { Store, type StoreFaults } from '../../src/infrastructure/store.ts';
import { appServer } from '../../src/infrastructure/server.ts';
import { createTelemetry, type Telemetry, type TelemetryMode } from '../../src/infrastructure/telemetry.ts';

export const T0 = Date.parse('2026-10-11T12:00:00.000Z');
export type FakeClock = Clock & { advance(ms: number): void; set(ms: number): void };
export function fakeClock(start = T0): FakeClock {
  let now = start;
  return { now: () => now, advance(ms) { now += ms; }, set(ms) { now = ms; } };
}
export const MINUTE = 60_000;

export const stubProvider: ModelProvider = {
  name: 'stub', model: null, mode: 'mock',
  async complete() { throw new Error('The stub provider is never called by the stub agent.'); },
};
export const stubKnowledge: KnowledgeIndex = { version: 'test', select: () => [], get: () => undefined, all: () => [] };

export interface StubAgent extends AgentService {
  calls: number;
  /** When set, handleTurn awaits this promise before acting (concurrency tests). */
  gate: Promise<void> | null;
  /** When set, handleTurn throws after optionally publishing (truthful-failure tests). */
  throwAfter: 'nothing' | 'publish' | null;
  /** When set, replaces the default behaviour entirely (fault seams: lie after publish, hang after publish). */
  script: ((input: AgentTurnInput) => Promise<AgentTurnResult>) | null;
  lastInput: AgentTurnInput | null;
}
/** A promise that never settles: stands in for a process that dies mid-turn. */
export const never = () => new Promise<never>(() => {});

const message = (r: PublishResult): AgentTurnResult['messages'][number] => r.state === 'committed'
  ? { role: 'tailor', status: 'applied', text: `Saved version ${r.version}: ${r.readback.traceIds.length} trace(s), ${r.readback.spanIds.length} span(s).`, evidence: { version: r.readback.version, traceIds: r.readback.traceIds, spanIds: r.readback.spanIds } }
  : { role: 'tailor', status: r.state === 'readback_uncertain' ? 'uncertain' : 'failed', text: `Not saved (${r.state}).` };

/** Deterministic agent: travel-booking text publishes v1, "retry fail" publishes the v2 edit, anything else answers. */
export function stubAgent(): StubAgent {
  const agent: StubAgent = {
    calls: 0, gate: null, throwAfter: null, script: null, lastInput: null,
    async handleTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      agent.calls++;
      agent.lastInput = input;
      if (agent.gate) await agent.gate;
      if (agent.script) return agent.script(input);
      const execution = { mode: 'mock' as const, provider: input.provider.name, model: input.provider.model };
      const text = input.request.text.toLowerCase();
      const proposal = /travel-booking/.test(text) ? travelProposalV1 : /retry fail/.test(text) ? travelProposalV2 : null;
      if (agent.throwAfter === 'nothing') throw new Error('stub agent failure');
      if (!proposal) return { outcome: 'answered', messages: [{ role: 'tailor', status: 'note', text: 'Stub answer.' }], steps: [], execution };
      const result = await input.telemetry.step('model', { provider: input.provider.name }, async () => input.tools.publishScenario(proposal));
      if (agent.throwAfter === 'publish') throw new Error('stub agent failure after publish');
      const outcome = result.state === 'committed' ? 'committed' : result.state === 'unsupported' ? 'unsupported' : result.state;
      return {
        outcome, messages: [message(result)], steps: [{ name: 'save', status: result.state === 'committed' ? 'ok' : 'failed' }], execution,
        ...(result.state === 'committed' ? { evidence: result.readback, story: proposal.story } : {}),
      };
    },
  };
  return agent;
}

export interface Harness {
  dir: string; path: string; clock: FakeClock; store: Store; server: Server; port: number; agent: StubAgent; telemetry: Telemetry;
  call(path: string, method?: string, data?: unknown, cookie?: string, extra?: Record<string, string>): Promise<{ status: number; data: any; cookie: string; setCookie: string | null }>;
  restart(): Promise<void>;
  /** Simulates SIGKILL: drops every connection and the in-memory turn lock, then reopens the same DB file. */
  crash(): Promise<void>;
  close(): Promise<void>;
}
export const DEV_KEY = 'local-test-key';

export async function harness(options: { faults?: StoreFaults; telemetry?: TelemetryMode; provider?: ModelProvider } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-backend-'));
  const path = join(dir, 'sessions.sqlite');
  const clock = fakeClock();
  const agent = stubAgent();
  const provider = options.provider ?? stubProvider;
  const telemetry = await createTelemetry({ mode: options.telemetry ?? 'disabled', secret: 'test-secret-for-correlation' });
  const start = async (store: Store) => {
    const server = appServer(store, { devKey: DEV_KEY, agent, provider, knowledge: stubKnowledge, telemetry, clock });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return server;
  };
  const h: Harness = {
    dir, path, clock, agent, telemetry,
    store: new Store(path, { clock, ...(options.faults ? { faults: options.faults } : {}) }),
    server: undefined as unknown as Server, port: 0,
    async call(p, method = 'GET', data, cookie = '', extra = {}) {
      const response = await fetch(`http://127.0.0.1:${h.port}${p}`, {
        method,
        headers: { cookie, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-tailor-dev-key': DEV_KEY, ...extra },
        body: data !== undefined ? JSON.stringify(data) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      return { status: response.status, data: await response.json(), cookie: setCookie?.split(';')[0] ?? cookie, setCookie };
    },
    async restart() {
      await new Promise<void>(r => h.server.close(() => r()));
      h.store.close();
      h.store = new Store(path, { clock });
      h.server = await start(h.store);
      h.port = (h.server.address() as { port: number }).port;
    },
    async crash() {
      h.server.closeAllConnections();
      await new Promise<void>(r => h.server.close(() => r()));
      h.store.close();
      h.store = new Store(path, { clock });
      h.server = await start(h.store);
      h.port = (h.server.address() as { port: number }).port;
    },
    async close() {
      await new Promise<void>(r => h.server.close(() => r()));
      h.store.close();
      await telemetry.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  h.server = await start(h.store);
  h.port = (h.server.address() as { port: number }).port;
  return h;
}

export function tempStore(options: { faults?: StoreFaults; clock?: FakeClock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tailor-store-'));
  const path = join(dir, 'sessions.sqlite');
  const clock = options.clock ?? fakeClock();
  const store = new Store(path, { clock, ...(options.faults ? { faults: options.faults } : {}) });
  return { dir, path, clock, store, cleanup() { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}
export const op = () => randomUUID();
