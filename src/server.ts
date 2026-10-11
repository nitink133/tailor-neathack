import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, Failure, findSpan, findTrace, isGone, traceList, traceQuery, type StoredTurn } from './store.ts';
import { createSessionTools } from './session-tools.ts';
import { storyProblems } from './validator.ts';
import type { Telemetry } from './telemetry.ts';
import type { ChatStatus, ChatTurn } from './contracts.ts';
import {
  LIMITS,
  type AgentService, type AgentTurnResult, type Clock, type KnowledgeIndex, type ModelProvider, type TurnOutcome,
  type TurnRequest, type TurnResponse, type TurnTelemetry,
} from './agent-contract.ts';

export interface AppServerOptions {
  devKey?: string;
  agent: AgentService;
  provider: ModelProvider;
  escalationProvider?: ModelProvider;
  knowledge: KnowledgeIndex;
  telemetry: Telemetry;
  /** Defaults to the store's clock so lifecycle and validation share one server clock. */
  clock?: Clock;
}

const COOKIE_MAX_AGE_S = LIMITS.lifetimeMs / 1000;
const TURN_OUTCOMES: readonly TurnOutcome[] = ['answered', 'clarification', 'committed', 'rejected', 'save_failed', 'readback_uncertain', 'conflict', 'unsupported', 'refused', 'expired', 'provider_unavailable'];
const CHAT_STATUSES: readonly ChatStatus[] = ['pending', 'applied', 'failed', 'uncertain', 'question', 'note'];
const BUYER_STATUS: Record<TurnOutcome, ChatStatus> = {
  committed: 'applied', readback_uncertain: 'uncertain',
  rejected: 'failed', save_failed: 'failed', conflict: 'failed', provider_unavailable: 'failed', expired: 'failed', refused: 'failed',
  answered: 'note', clarification: 'note', unsupported: 'note',
};

const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)tailor=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Failure(415, 'CONTENT_TYPE', 'Use application/json.');
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32000) throw new Failure(413, 'BODY_TOO_LARGE', 'Request exceeds 32 KB.'); }
  try { return JSON.parse(raw); } catch { throw new Failure(400, 'INVALID_JSON', 'Request must contain complete JSON.'); }
}
function turnRequestOf(data: any): TurnRequest {
  const text = data?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.maxTurnTextChars) throw new Failure(422, 'TURN_TEXT_INVALID', `Send 1–${LIMITS.maxTurnTextChars} characters of text.`);
  if (typeof data.clientTurnId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(data.clientTurnId)) throw new Failure(422, 'TURN_TEXT_INVALID', 'Send a client-generated clientTurnId (UUID).');
  if (data.choiceId !== undefined && (typeof data.choiceId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(data.choiceId))) throw new Failure(422, 'TURN_TEXT_INVALID', 'choiceId must be a short choice identifier.');
  return { text: text.trim(), clientTurnId: data.clientTurnId, ...(data.choiceId !== undefined ? { choiceId: data.choiceId } : {}) };
}

export function appServer(store: Store, options: AppServerOptions) {
  const { devKey, agent, provider, escalationProvider, knowledge, telemetry } = options;
  const clock = options.clock ?? store.clock;
  const inFlight = new Set<string>();
  const execution = () => ({ mode: provider.mode, provider: provider.name, model: provider.model });

  /** Normalises an agent result so only truthful, bounded tailor turns reach the transcript. */
  function sanitise(result: AgentTurnResult, before: number, current: number): AgentTurnResult {
    if (!result || !TURN_OUTCOMES.includes(result.outcome)) throw new Error('Agent returned an unknown outcome.');
    let outcome = result.outcome;
    // A success claim requires the authoritative version to have moved and match the readback evidence.
    if (outcome === 'committed' && !(current > before && result.evidence?.version === current)) outcome = 'readback_uncertain';
    const messages = (Array.isArray(result.messages) ? result.messages : []).flatMap(m => {
      const text = typeof m?.text === 'string' ? m.text.trim().slice(0, LIMITS.maxTurnTextChars) : '';
      if (!text) return [];
      let status: ChatStatus = CHAT_STATUSES.includes(m.status) && m.status !== 'pending' ? m.status : 'note';
      if (status === 'applied' && outcome !== 'committed') status = outcome === 'readback_uncertain' ? 'uncertain' : 'failed';
      const turn: Omit<ChatTurn, 'id' | 'at'> = { role: 'tailor', text, status };
      if (status === 'question' && m.clarification) turn.clarification = m.clarification;
      if (outcome === 'committed' && m.evidence) turn.evidence = m.evidence;
      return [turn];
    }).slice(0, 8);
    return {
      outcome, messages,
      ...(result.clarification ? { clarification: result.clarification } : {}),
      ...(outcome === 'committed' && result.evidence ? { evidence: result.evidence } : {}),
      steps: Array.isArray(result.steps) ? result.steps.slice(0, 24) : [],
      execution: result.execution ?? execution(),
      ...(outcome === 'committed' && result.story ? { story: result.story } : {}),
    };
  }
  function failure(current: number, before: number): AgentTurnResult {
    const unchanged = current === before;
    return {
      outcome: unchanged ? 'provider_unavailable' : 'readback_uncertain',
      messages: [unchanged
        ? { role: 'tailor', status: 'failed', text: `Tailor could not finish this request, so nothing changed. Version ${current} is still live.` }
        : { role: 'tailor', status: 'uncertain', text: `Tailor could not confirm whether this request was saved. The demo now reports version ${current}; reload it before relying on the change.` }],
      steps: [{ name: 'model', status: 'failed', detail: 'The agent stopped before finishing this turn.' }],
      execution: execution(),
    };
  }
  async function runTurn(id: string, request: TurnRequest, turnId: string, tt: TurnTelemetry): Promise<TurnResponse> {
    const before = store.snapshot(id);
    const { appended: [buyer] } = store.appendTurns(id, [{ role: 'buyer', text: request.text, status: 'pending' }], { expectedConversationVersion: before.conversationVersion });
    const tools = createSessionTools(store, id, clock, tt);
    let result: AgentTurnResult;
    try {
      const raw = await agent.handleTurn({ session: store.snapshot(id), request, tools, knowledge, telemetry: tt, clock, provider, ...(escalationProvider ? { escalationProvider } : {}) });
      result = sanitise(raw, before.version, store.read(id).version);
    } catch (e) {
      if (isGone(e)) throw e;
      result = failure(store.read(id).version, before.version);
    }
    const status = BUYER_STATUS[result.outcome];
    const story = result.story && storyProblems(result.story).length === 0 ? result.story : undefined;
    let response: TurnResponse | undefined;
    store.appendTurns(id, result.messages, {
      settle: { id: buyer!.id, status },
      ...(story ? { story } : {}),
      respond: (appended, next): StoredTurn => {
        response = {
          turnId, outcome: result.outcome, version: next.version, conversationVersion: next.conversationVersion,
          messages: [{ ...buyer!, status }, ...appended],
          ...(result.clarification ? { clarification: result.clarification } : {}),
          ...(result.evidence ? { evidence: result.evidence } : {}),
          steps: result.steps, execution: result.execution,
        };
        return { clientTurnId: request.clientTurnId, response };
      },
    });
    return response!;
  }

  return createServer(async (req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Loopback-only Host and same-origin writes also prevent DNS rebinding/CSRF.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) throw new Failure(403, 'LOCAL_ONLY', 'Use the local loopback server.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Failure(403, 'ORIGIN', 'Cross-origin requests are not supported.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (path === '/api/sessions' && req.method === 'POST') {
          const data = await body(req);
          const s = store.create(data?.description, data?.scenario, String(req.headers['idempotency-key'] ?? ''), data?.conversation);
          res.setHeader('Set-Cookie', `tailor=${s.id}.${store.token(s.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`);
          return send(201, s);
        }
        if (path.startsWith('/api/dev/')) {
          if (!devKey || req.headers['x-tailor-dev-key'] !== devKey) throw new Failure(403, 'DEVELOPER_ONLY', 'Developer inspection is disabled or requires the local developer key.');
          if (path === '/api/dev/sessions' && req.method === 'GET') return send(200, store.list());
          const match = /^\/api\/dev\/sessions\/([\w-]+)\/proposal$/.exec(path);
          if (match && req.method === 'POST') {
            store.authorize(match[1]!, cookieOf(req));
            return send(200, store.publishDataset(match[1]!, await body(req)));
          }
          throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported developer action.');
        }
        const turnRoute = /^\/api\/sessions\/([\w-]+)\/turns$/.exec(path);
        if (turnRoute && req.method === 'POST') {
          const id = turnRoute[1]!;
          store.authorize(id, cookieOf(req));
          const request = turnRequestOf(await body(req));
          const turnId = randomUUID();
          const tt = telemetry.forTurn(turnId, id);
          const started = performance.now();
          const result = await tt.step('turn', { provider: provider.name, providerMode: provider.mode }, async () => {
            store.touch(id);
            const prior = store.lastTurn(id);
            if (prior && prior.clientTurnId === request.clientTurnId) { tt.event('turn.replayed', { version: prior.response.version }); return prior.response; }
            if (inFlight.has(id)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Tailor is still working on your previous message.');
            inFlight.add(id);
            try {
              const response = await runTurn(id, request, turnId, tt);
              tt.event('turn.result', { outcome: response.outcome, version: response.version, conversationVersion: response.conversationVersion, latencyMs: Math.round(performance.now() - started) });
              return response;
            } finally { inFlight.delete(id); }
          });
          return send(200, result);
        }
        const scenarioRoute = /^\/api\/sessions\/([\w-]+)\/scenario$/.exec(path);
        if (scenarioRoute && req.method === 'POST') {
          store.authorize(scenarioRoute[1]!, cookieOf(req));
          const data = await body(req);
          return send(200, store.applyScenario(scenarioRoute[1]!, data?.scenario, data?.expectedVersion));
        }
        const endRoute = /^\/api\/sessions\/([\w-]+)\/end$/.exec(path);
        if (endRoute && req.method === 'POST') {
          store.authorize(endRoute[1]!, cookieOf(req));
          const ended = store.end(endRoute[1]!);
          res.setHeader('Set-Cookie', 'tailor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(200, ended);
        }
        if (req.method !== 'GET') throw new Failure(405, 'UNSUPPORTED_ACTION', 'This action is not supported.');
        if (path === '/api/session') {
          const cookie = cookieOf(req); const id = cookie.split('.')[0]!;
          store.authorize(id, cookie); store.touch(id); return send(200, store.read(id));
        }
        const route = /^\/api\/sessions\/([\w-]+)(?:\/traces(?:\/([\w-]+)(?:\/spans\/([\w-]+))?)?)?$/.exec(path);
        if (!route) throw new Failure(404, 'NOT_FOUND', 'API route not found.');
        const [, id, traceId, spanId] = route;
        store.authorize(id!, cookieOf(req));
        store.touch(id!);
        const session = store.read(id!);
        if (traceId) {
          const trace = findTrace(session, traceId);
          if (!trace) throw new Failure(404, 'NOT_FOUND', 'Trace not found in this session.');
          if (spanId) {
            const span = findSpan(trace, spanId);
            if (!span) throw new Failure(404, 'NOT_FOUND', 'Span not found in this trace.');
            return send(200, { version: session.version, span });
          }
          return send(200, { version: session.version, trace });
        }
        if (path.endsWith('/traces')) {
          const q = traceQuery(Object.fromEntries(url.searchParams), session.dataset.traces.map(t => t.scenario));
          return send(200, traceList(session, q));
        }
        return send(200, session);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Failure(405,'UNSUPPORTED_ACTION','Unsupported action.');
      let file = '/index.html';
      if (path === '/app.js') file = '../dist/client.js';
      else if (path === '/adapter.js') file = '../dist/adapter.js';
      else if (path === '/agent.js') file = '../dist/agent.js';
      else if (path === '/style.css' || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) file = path;
      else if (!(path==='/' || path==='/entry' || /^\/demo\/[^/]+\/traces(?:\/[^/]+)?$/.test(path))) throw new Failure(404,'NOT_FOUND','Page not found.');
      const full = file.startsWith('../dist/') ? resolve('dist', file.slice('../dist/'.length)) : resolve('public',file.slice(1));
      let content: Buffer;
      try { content = await readFile(full); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') throw new Failure(404, 'NOT_FOUND', 'File not found.'); throw e; }
      const types:Record<string,string> = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.webp':'image/webp'};
      res.writeHead(200,{'content-type':types[extname(full)] ?? 'application/octet-stream'}); res.end(req.method==='HEAD' ? undefined : content);
    } catch(e) {
      const failure = e instanceof Failure ? e : new Failure(500,'SERVER_FAILURE','Local request failed. Retry; previous accepted session state is retained.');
      if (!res.headersSent && !res.destroyed) send(failure.status,{error:{code:failure.code,message:failure.message}});
    }
  });
}

/** Periodically deletes expired sessions and old tombstones. The timer never keeps the process alive. */
export function startSweeper(store: Store, clock: Clock, intervalMs: number = LIMITS.sweepIntervalMs): () => void {
  const timer = setInterval(() => { try { store.sweep(clock.now()); } catch { /* next tick retries */ } }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
