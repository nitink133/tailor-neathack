import { createRoutingService, RoutingError } from '../clients/neatlogs/routing-service.ts';
import type { RoutingService, StoredRoutingPreview } from '../clients/neatlogs/routing-contract.ts';
import type { DemoSwitchChoice } from '../tailor/demo-contract.ts';
import { createEvaluationService, EvaluationError } from '../clients/neatlogs/eval-service.ts';
import { publicCapabilities } from '../clients/neatlogs/capabilities.ts';
import type { EvaluationService, StoredEvaluation } from '../clients/neatlogs/eval-contract.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Store, Failure, findSpan, findTrace, isGone, traceList, traceQuery, type StoredTurn } from './store.ts';
import { createSessionTools, readbackObserver } from '../clients/neatlogs/session-tools.ts';
import { storyProblems } from '../clients/neatlogs/validator.ts';
import { isCurrentGuidance } from '../clients/neatlogs/guidance.ts';
import type { Telemetry } from './telemetry.ts';
import { BUYER_STATUS, createTurnGate, reconcileTurnResult, requestFingerprint, unfinishedTurnResult } from '../tailor/lifecycle.ts';
import {
  LIMITS,
  type AgentService, type AgentTurnResult, type Clock, type ExecutionInfoResponse, type ExecutionLabel, type KnowledgeIndex, type ModelProvider,
  type TurnRequest, type TurnResponse, type TurnTelemetry,
} from '../clients/neatlogs/agent-contract.ts';

export interface AppServerOptions {
  devKey?: string;
  agent: AgentService;
  provider: ModelProvider;
  escalationProvider?: ModelProvider;
  knowledge: KnowledgeIndex;
  telemetry: Telemetry;
  /** Defaults to the store's clock so lifecycle and validation share one server clock. */
  clock?: Clock;
  evaluations?: EvaluationService;
  routing?: RoutingService;
  capabilities?: () => unknown;
  /** Trusted harness only; buyer-authored descriptions cannot opt into exporting payloads. */
  syntheticFixture?: (demoId: string) => boolean;
  /** Live-provider spend guard; exposes its estimated-usage summary on GET /api/dev/spend. Absent for the mock. */
  spend?: { summary(): unknown };
}

const COOKIE_MAX_AGE_S = LIMITS.lifetimeMs / 1000;
/**
 * Compatibility label for scripted fixtures. Labels are buyer-controlled and do not authorize payload export.
 * Export additionally requires the server-owned syntheticFixture predicate and telemetry syntheticPayloads option.
 */
export const SYNTHETIC_FIXTURE_PREFIX = 'SYNTHETIC hosted-verification';

const MAX_BODY_BYTES = 32000;
const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)tailor=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
async function body(req: IncomingMessage): Promise<any> {
  const mediaType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new Failure(415, 'CONTENT_TYPE', 'Use application/json.');
  // Decode once after collecting bytes: per-chunk decoding splits multi-byte UTF-8 code points.
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Failure(413, 'BODY_TOO_LARGE', 'Request exceeds 32 KB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { throw new Failure(400, 'INVALID_JSON', 'Request must contain complete JSON.'); }
}
const traceNotFound = () => new Failure(422, 'TRACE_NOT_FOUND', 'The open trace is not part of this demo. Reload the trace list and try again.');
function turnRequestOf(data: any): TurnRequest {
  const text = data?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.maxTurnTextChars) throw new Failure(422, 'TURN_TEXT_INVALID', `Send 1–${LIMITS.maxTurnTextChars} characters of text.`);
  if (typeof data.clientTurnId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(data.clientTurnId)) throw new Failure(422, 'TURN_TEXT_INVALID', 'Send a client-generated clientTurnId (UUID).');
  if (data.choiceId !== undefined && (typeof data.choiceId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(data.choiceId))) throw new Failure(422, 'TURN_TEXT_INVALID', 'choiceId must be a short choice identifier.');
  const confirmationRef = data.confirmationRef ?? undefined;
  if (confirmationRef !== undefined && (typeof confirmationRef !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(confirmationRef))) throw new Failure(422, 'INVALID_CONFIRMATION', 'Send the saved confirmation reference.');
  const openTraceId = data.openTraceId ?? undefined;
  if (openTraceId !== undefined && (typeof openTraceId !== 'string' || !/^[\w-]{1,120}$/.test(openTraceId))) throw traceNotFound();
  return { text: text.trim(), clientTurnId: data.clientTurnId, ...(data.choiceId !== undefined ? { choiceId: data.choiceId } : {}), ...(openTraceId !== undefined ? { openTraceId } : {}), ...(confirmationRef !== undefined ? { confirmationRef } : {}) };
}
/** Idempotency fingerprint: a reused clientTurnId must carry the same request. */
const requestHash = (r: TurnRequest) => requestFingerprint([r.text, r.choiceId ?? null, r.openTraceId ?? null, ...(r.confirmationRef ? [r.confirmationRef] : [])]);

export function appServer(store: Store, options: AppServerOptions) {
  const { devKey, agent, provider, escalationProvider, knowledge, telemetry } = options;
  const clock = options.clock ?? store.clock;
  const gate = createTurnGate();
  const evaluations = options.evaluations ?? createEvaluationService({
    list: id => store.listArtifacts<StoredEvaluation>(id, 'evaluations'),
    read: (id, evaluationId) => store.readArtifact<StoredEvaluation>(id, 'evaluations', evaluationId),
    compareAndSet: (id, evaluationId, version, next) => store.compareAndSetArtifact(id, 'evaluations', evaluationId, version, next),
  }, { now: () => new Date(clock.now()) });
  const routing = options.routing ?? createRoutingService({
    list: id => store.listArtifacts<StoredRoutingPreview>(id, 'routing'),
    read: (id, previewId) => store.readArtifact<StoredRoutingPreview>(id, 'routing', previewId),
    compareAndSet: (id, previewId, version, next) => store.compareAndSetArtifact(id, 'routing', previewId, version, next),
  }, { now: () => new Date(clock.now()) });
  const execution = (): ExecutionLabel => ({ mode: provider.mode, provider: provider.name, model: provider.model, effort: provider.effort ?? null });
  const withExecution = <T extends object>(data: T): T & ExecutionInfoResponse => {
    const id = (data as { id?: unknown }).id;
    const hosted = telemetry.mode === 'neatlogs' && telemetry.diagnostics().syntheticPayloads;
    const approved = typeof id === 'string' && options.syntheticFixture?.(id) === true;
    return { ...data, execution: execution(), ...(typeof id === 'string' ? { payloadCapture: {
      enabled: hosted && approved,
      reason: !hosted ? 'hosted_export_disabled' : approved ? 'approved_synthetic_session' : 'session_not_approved',
      maxTextChars: LIMITS.maxTurnTextChars,
    } } : {}) };
  };
  const devKeyHash = devKey ? createHash('sha256').update(devKey).digest() : null;
  const devAllowed = (given: unknown) => devKeyHash !== null && typeof given === 'string' && timingSafeEqual(createHash('sha256').update(given).digest(), devKeyHash);

  async function runTurn(id: string, request: TurnRequest, hash: string, turnId: string, tt: TurnTelemetry, signal?: AbortSignal): Promise<TurnResponse> {
    // Transaction 1: pending buyer turn + durable running record. The publish transaction marks it published; the
    // final append settles it with the response. A crash in between is settled on retry or by the sweep, never re-run.
    const { run, buyer } = store.beginTurn(id, { clientTurnId: request.clientTurnId, requestHash: hash, text: request.text, turnId, execution: execution() });
    const before = run.startedVersion;
    const tools = createSessionTools(store, id, clock, tt, { clientTurnId: request.clientTurnId, requestedText: request.text, signal });
    let result: AgentTurnResult;
    let responseDemoId = id;
    let separateText: string | undefined;
    try {
      if (signal?.aborted) throw new Error('Request cancelled before execution.');
      if (request.confirmationRef) {
        const resolve = () => Promise.resolve(store.resolveSwitch(id, request.confirmationRef!, request.choiceId as DemoSwitchChoice, request.clientTurnId, readbackObserver(tt)));
        const saveOrdinal = Math.max(0, ...(tt.evidence?.snapshot().expected.filter(e => e.operation === 'save').map(e => e.ordinal) ?? [])) + 1;
        if (request.choiceId !== 'keep_current') tt.evidence?.expect('save', saveOrdinal);
        const resolved = request.choiceId === 'keep_current' ? await resolve() : await tt.step('save', { evidenceOrdinal: saveOrdinal }, resolve);
        responseDemoId = resolved.demoId;
        separateText = responseDemoId !== id ? resolved.requestedText : undefined;
        const saved = resolved.result;
        if (!saved) result = { outcome: 'answered', messages: [{ role: 'tailor', status: 'note', text: 'Kept the current demo. Its saved workflow is unchanged.' }], steps: [], execution: execution() };
        else if (saved.state === 'committed') result = {
          outcome: 'committed', messages: [{ role: 'tailor', status: 'applied', text: `${responseDemoId === id ? 'Adapted the current demo' : 'Started a separate demo and preserved the previous one'}. Saved and verified version ${saved.version}.`, evidence: { version: saved.version, traceIds: saved.readback.traceIds, spanIds: saved.readback.spanIds } }],
          evidence: saved.readback, steps: [{ name: 'save', status: 'ok' }, { name: 'readback', status: 'ok' }], execution: execution(),
        };
        else if (saved.state === 'readback_uncertain') result = { outcome: 'readback_uncertain', messages: [{ role: 'tailor', status: 'uncertain', text: 'The demo may have been saved, but I could not confirm it. Reload before relying on the change.' }], steps: [{ name: 'readback', status: 'failed' }], execution: execution() };
        else result = { outcome: saved.state === 'unsupported' ? 'unsupported' : saved.state, messages: [{ role: 'tailor', status: 'failed', text: 'The switch could not be completed. Reload the saved demo before trying again.' }], steps: [{ name: 'save', status: 'failed' }], execution: execution() };
        tt.evidence?.expect('response');
        tt.evidence?.observe('response', 1, 'start', 'ok');
        tt.evidence?.observe('response', 1, 'end', 'ok');
      } else {

      const raw = await agent.handleTurn({ session: store.snapshot(id), request, tools, knowledge, telemetry: tt, clock, provider, signal, ...(escalationProvider ? { escalationProvider } : {}) });
      result = reconcileTurnResult(raw, before, store.read(id).version, execution());
      }
    } catch (e) {
      if (signal?.aborted) tt.evidence?.interrupt('cancelled');
      if (isGone(e)) { tt.evidence?.interrupt('expired'); throw e; }
      result = unfinishedTurnResult(store.read(id).version, before, execution());
    }
    const status = BUYER_STATUS[result.outcome];
    const story = responseDemoId === id && result.story && storyProblems(result.story).length === 0 ? result.story : undefined;
    const target = separateText ? store.appendTurns(responseDemoId, [{ role: 'buyer', text: separateText, status }, ...result.messages]).session : undefined;
    let response: TurnResponse | undefined;
    store.appendTurns(id, result.messages, {
      settle: { id: buyer.id, status },
      ...(story ? { story } : {}),
      respond: (appended, next): StoredTurn => {
        response = {
          turnId, outcome: result.outcome, version: target?.version ?? next.version, conversationVersion: target?.conversationVersion ?? next.conversationVersion,
          ...(store.ownerOf(id) ? { demoId: responseDemoId, sessionId: store.ownerOf(id)! } : {}),
          messages: [{ ...buyer, status }, ...appended],
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
    const requestId = randomUUID();
    res.setHeader('X-Tailor-Request-Id', requestId);
    const cancellation = new AbortController();
    req.once('aborted', () => cancellation.abort());
    res.once('close', () => { if (!res.writableEnded) cancellation.abort(); });
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
        const setBrowserCookie = (id: string) => res.setHeader('Set-Cookie', `tailor=${store.browserCookie(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`);
        if (path === '/api/capabilities' && req.method === 'GET') return send(200, (options.capabilities ?? publicCapabilities)());
        if (path === '/api/browser-session' && req.method === 'POST') {
          const existing = store.browserForCookie(cookieOf(req), true);
          const browser = existing ? store.browserSession(existing) : store.createBrowserSession();
          setBrowserCookie(browser.id); return send(200, browser);
        }
        if (path === '/api/browser-session' && req.method === 'GET') {
          const owner = store.browserForCookie(cookieOf(req), true);
          if (!owner) throw new Failure(404, 'NOT_FOUND', 'This browser has no saved demos yet.');
          store.touchBrowser(owner); setBrowserCookie(owner);
          return send(200, store.browserSession(owner));
        }
        if (path === '/api/browser-session/active-demo' && req.method === 'POST') {
          const owner = store.browserForCookie(cookieOf(req), true);
          if (!owner) throw new Failure(404, 'NOT_FOUND', 'This browser has no saved demos yet.');
          if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before switching demos.');
          const data = await body(req);
          if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before switching demos.');
          const selected = store.selectDemo(owner, data?.demoId, data?.expectedVersion); setBrowserCookie(owner);
          return send(200, selected);
        }
        if ((path === '/api/sessions' || path === '/api/browser-session/demos') && req.method === 'POST') {
          const data = await body(req);
          const cookie = cookieOf(req);
          const owner = cookie ? store.browserForCookie(cookie, true) : null;
          if (owner && gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before creating a demo.');
          if (owner || path === '/api/browser-session/demos') {
            const created = store.createOwned(owner, data?.description, data?.scenario, String(req.headers['idempotency-key'] ?? ''), data?.conversation);
            setBrowserCookie(created.ownerId);
            return send(201, withExecution(created.session));
          }
          const s = store.create(data?.description, data?.scenario, String(req.headers['idempotency-key'] ?? ''), data?.conversation);
          res.setHeader('Set-Cookie', `tailor=${s.id}.${store.token(s.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`);
          return send(201, withExecution(s));
        }
        if (path === '/api/execution') {
          if (req.method !== 'GET') throw new Failure(405, 'UNSUPPORTED_ACTION', 'This action is not supported.');
          return send(200, { execution: execution() } satisfies ExecutionInfoResponse);
        }
        if (path.startsWith('/api/dev/')) {
          if (!devAllowed(req.headers['x-tailor-dev-key'])) throw new Failure(403, 'DEVELOPER_ONLY', 'Developer inspection is disabled or requires the local developer key.');
          // Identifiers and lifecycle metadata only: descriptions, transcripts and datasets stay behind the session cookie.
          if (path === '/api/dev/sessions' && req.method === 'GET') {
            return send(200, store.list().map(s => ({
              id: s.id, state: s.state, createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, expiresAt: s.expiresAt,
              version: s.version, conversationVersion: s.conversationVersion, turnCount: s.conversation.length, traceCount: s.dataset.traces.length,
            })));
          }
          if (path === '/api/dev/telemetry' && req.method === 'GET') return send(200, telemetry.diagnostics());
          if (path === '/api/dev/telemetry/flush' && req.method === 'POST') return send(200, await telemetry.flush());
          // Spend summary: provider-reported usage × configured rates. Estimates only; Anthropic billing is authoritative.
          if (path === '/api/dev/spend' && req.method === 'GET') {
            return send(200, options.spend ? { available: true, ...(options.spend.summary() as object) } : { available: false, reason: 'No live provider configured; the mock provider spends nothing.' });
          }
          const match = /^\/api\/dev\/sessions\/([\w-]+)\/proposal$/.exec(path);
          if (match && req.method === 'POST') {
            store.authorize(match[1]!, cookieOf(req));
            return send(200, store.publishDataset(match[1]!, await body(req)));
          }
          throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported developer action.');
        }
        const guidanceRoute = /^\/api\/sessions\/([\w-]+)\/guidance-events$/.exec(path);
        if (guidanceRoute) {
          const id = guidanceRoute[1]!; const owner = store.authorize(id, cookieOf(req));
          if (req.method !== 'POST') throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported guidance action.');
          const data = await body(req);
          const outcomes = ['selected', 'shown', 'failed', 'dismissed'];
          const reasons = ['stale', 'missing', 'navigation', 'loading', 'dismissed', 'render'];
          if (!data || Array.isArray(data) || Object.keys(data).some(k => !['messageId', 'suggestionId', 'outcome', 'reason'].includes(k)) ||
            typeof data.messageId !== 'string' || data.messageId.length > 100 || typeof data.suggestionId !== 'string' || data.suggestionId.length > 450 ||
            !outcomes.includes(data.outcome) || (data.reason !== undefined && !reasons.includes(data.reason))) {
            throw new Failure(422, 'INVALID_TURN', 'Invalid guidance observation.');
          }
          const session = store.read(id);
          const message = session.conversation.find(m => m.id === data.messageId && m.role === 'tailor');
          const suggestion = message?.guidance?.find(g => g.id === data.suggestionId);
          if (!suggestion || !['trace.overview', 'trace.slowest-span', 'trace.model-call', 'trace.output'].includes(suggestion.targetId)) {
            throw new Failure(404, 'NOT_FOUND', 'Guidance not found in this demo.');
          }
          const binding = suggestion.binding;
          const current = isCurrentGuidance(suggestion, session);
          // A browser observation cannot turn outdated guidance into a successful show.
          if (data.outcome === 'shown' && !current) throw new Failure(409, 'STALE_VERSION', 'Guidance no longer matches this demo.');
          const recorded = await telemetry.guidanceEvent?.(owner, id, {
            messageId: message!.id, suggestionId: suggestion.id, targetId: suggestion.targetId,
            targetKey: `${binding.traceId}:${binding.spanId ?? ''}`, version: session.version,
            synthetic: options.syntheticFixture?.(id) === true,
            outcome: data.outcome, ...(data.reason ? { reason: data.reason } : {}),
          }).catch(() => false) ?? false;
          return send(200, { recorded, receiptState: 'unverified' });
        }
        const routingRoute = /^\/api\/sessions\/([\w-]+)\/routing(?:\/([\w-]+))?$/.exec(path);
        if (routingRoute) {
          const id = routingRoute[1]!; const owner = store.authorize(id, cookieOf(req));
          store.touch(id); if (store.ownerOf(id)) store.touchBrowser(owner);
          if (req.method === 'GET') return send(200, routingRoute[2] ? routing.read(store.read(id), routingRoute[2]) : routing.list(store.read(id)));
          if (req.method === 'POST' && !routingRoute[2]) {
            if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before previewing routing.');
            const data = await body(req);
            if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before previewing routing.');
            return send(201, routing.create(store.read(id), data));
          }
          throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported routing action.');
        }
        const evalRoute = /^\/api\/sessions\/([\w-]+)\/evaluations(?:\/([\w-]+)(?:\/(reviews))?)?$/.exec(path);
        if (evalRoute) {
          const id = evalRoute[1]!; const owner = store.authorize(id, cookieOf(req));
          store.touch(id); if (store.ownerOf(id)) store.touchBrowser(owner);
          const session = store.read(id); const evaluationId = evalRoute[2];
          if (req.method === 'GET' && !evalRoute[3]) return send(200, evaluationId ? evaluations.read(session, evaluationId) : evaluations.list(session));
          if (req.method === 'POST') {
            if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before reviewing this demo.');
            const data = await body(req);
            if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Wait for the current turn before reviewing this demo.');
            const latest = store.read(id);
            if (!evaluationId) return send(201, evaluations.create(latest, data));
            if (evalRoute[3]) return send(200, evaluations.review(latest, evaluationId, data));
          }
          throw new Failure(405, 'UNSUPPORTED_ACTION', 'Unsupported evaluation action.');
        }
        const turnRoute = /^\/api\/sessions\/([\w-]+)\/turns$/.exec(path);
        if (turnRoute && req.method === 'POST') {
          const id = turnRoute[1]!; const owner = store.authorize(id, cookieOf(req));
          const request = turnRequestOf(await body(req)); const hash = requestHash(request);
          store.touch(id); if (store.ownerOf(id)) store.touchBrowser(owner);
          const prior = store.findRun(id, request.clientTurnId, hash);
          const turnId = prior?.turnId ?? randomUUID();
          const manifest = prior ? store.readTurnEvidence(id, request.clientTurnId) : undefined;
          const tt = telemetry.forTurn(turnId, owner, { demoId: id, requestId, clientTurnId: request.clientTurnId,
            synthetic: options.syntheticFixture?.(id) === true,
            ...(manifest ? { manifest } : {}), onEvidence: snapshot => store.saveTurnEvidence(id, request.clientTurnId, snapshot) });
          // A replay restores evidence and correlation without generating another logical-turn trace.
          if (prior?.state === 'settled' && prior.response) return send(200, prior.response);
          if (gate.busy(owner)) throw new Failure(409, 'TURN_IN_FLIGHT', 'Tailor is still working on your previous message.');
          if (prior) {
            tt.evidence?.interrupt('crashed');
            return send(200, store.recoverRun(id, request.clientTurnId));
          }
          if (request.confirmationRef) store.assertSwitch(id, request.confirmationRef, request.choiceId);
          if (request.openTraceId !== undefined && !findTrace(store.read(id), request.openTraceId)) throw traceNotFound();
          const started = performance.now();
          tt.evidence?.expect('turn');
          const result = await tt.step('turn', { provider: provider.name, providerMode: provider.mode, evidenceOrdinal: 1, versionBefore: store.read(id).version }, async () => gate.run(owner, async () => {
            const response = await runTurn(id, request, hash, turnId, tt, cancellation.signal);
            tt.event('turn.result', { outcome: response.outcome, version: response.version, conversationVersion: response.conversationVersion, latencyMs: Math.round(performance.now() - started) });
            tt.attachSynthetic({ input: request.text, output: response.messages.filter(m => m.role === 'tailor').map(m => m.text).join('\n') });
            return response;
          }));
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
          if (!store.ownerOf(endRoute[1]!)) res.setHeader('Set-Cookie', 'tailor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(200, ended);
        }
        if (req.method !== 'GET') throw new Failure(405, 'UNSUPPORTED_ACTION', 'This action is not supported.');
        if (path === '/api/session') {
          const cookie = cookieOf(req); const owner = store.browserForCookie(cookie);
          const id = owner ? store.browserSession(owner).activeDemoId : cookie.split('.')[0]!;
          if (!id) throw new Failure(404, 'NOT_FOUND', 'Choose or create a demo first.');
          store.authorize(id, cookie); store.touch(id); if (owner) store.touchBrowser(owner); return send(200, withExecution(store.read(id)));
        }
        const route = /^\/api\/sessions\/([\w-]+)(?:\/traces(?:\/([\w-]+)(?:\/spans\/([\w-]+))?)?)?$/.exec(path);
        if (!route) throw new Failure(404, 'NOT_FOUND', 'API route not found.');
        const [, id, traceId, spanId] = route;
        const owner = store.authorize(id!, cookieOf(req));
        store.touch(id!); if (store.ownerOf(id!)) store.touchBrowser(owner);
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
        return send(200, withExecution(session));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Failure(405,'UNSUPPORTED_ACTION','Unsupported action.');
      let file = '/index.html';
      if (path === '/app.js') file = '../dist/clients/neatlogs/client.js';
      else if (path === '/entry-state.js') file = '../dist/clients/neatlogs/entry-state.js';
      else if (path === '/trace-guide.js') file = '../dist/clients/neatlogs/trace-guide.js';
      else if (path === '/guidance.js') file = '../dist/clients/neatlogs/guidance.js';
      else if (path === '/reply-format.js') file = '../dist/clients/neatlogs/reply-format.js';
      else if (path === '/turn-summary.js') file = '../dist/clients/neatlogs/turn-summary.js';
      else if (path === '/adapter.js') file = '../dist/adapter.js';
      else if (path === '/agent.js') file = '../dist/agent.js';
      else if (path === '/style.css' || /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) file = path;
      else if (!(path==='/' || path==='/entry' || /^\/demo\/[^/]+\/(?:traces(?:\/[^/]+)?|(?:evals|evaluations|routing|alerts)(?:\/[^/]+)?)$/.test(path))) throw new Failure(404,'NOT_FOUND','Page not found.');
      const full = file.startsWith('../dist/') ? resolve('dist', file.slice('../dist/'.length)) : resolve('public',file.slice(1));
      let content: Buffer;
      try { content = await readFile(full); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') throw new Failure(404, 'NOT_FOUND', 'File not found.'); throw e; }
      const types:Record<string,string> = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.webp':'image/webp'};
      res.writeHead(200,{'content-type':types[extname(full)] ?? 'application/octet-stream'}); res.end(req.method==='HEAD' ? undefined : content);
    } catch(e) {
      const failure = e instanceof Failure || e instanceof EvaluationError || e instanceof RoutingError ? e : new Failure(500,'SERVER_FAILURE','Local request failed. Retry; previous accepted session state is retained.');
      if (['SESSION_EXPIRED', 'NOT_FOUND'].includes(failure.code) && cookieOf(req)) {
        try { store.browserForCookie(cookieOf(req)); } catch { res.setHeader('Set-Cookie', 'tailor=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); }
      }
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
