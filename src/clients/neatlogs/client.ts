import type { GuidanceSuggestion } from '../../tailor/contract.ts';
import { isCurrentGuidance, sanitiseStoredGuidance } from './guidance.ts';
import type { ChatTurn, DemoSession, Json, Span, Trace, TraceList } from './contracts.ts';
import type { ExecutionInfoResponse, ExecutionLabel, TurnOutcome, TurnRequest, TurnResponse, TurnStep } from './agent-contract.ts';
import type { BrowserSession } from '../../tailor/demo-contract.ts';
import type { EvaluationCheck, EvaluationDetail, EvaluationList, EvaluationQuestion, ReviewEvaluationRequest } from './eval-contract.ts';
import type { RoutingDetail, RoutingList } from './routing-contract.ts';
import { entrySavedState, entrySuggestions, suggestionBatch } from './entry-state.ts';
import { replyBlocks, type ReplyTextBlock } from './reply-format.ts';
import { turnSummary } from './turn-summary.ts';
import { recommendedTrace, selectedSpanAncestors, traceGuideFacts } from './trace-guide.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icon = (name: string) => {
  const paths: Record<string,string> = { list:'M5 4v16h15M9 7h10M9 11h10M9 15h10', search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', back:'M20 12H4m6-6-6 6 6 6', refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5', tool:'M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-4 3-3-3z', tree:'M8 4v16m0-12h8m-8 8h8M5 2h6v4H5zM16 6h5v4h-5zM16 14h5v4h-5z', clock:'M12 7v5l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', check:'M7 12l3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', close:'M6 6l12 12M18 6 6 18', plus:'M12 8v8M8 12h8M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', minus:'M8 12h8M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', chevron:'m8 5 7 7-7 7', sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', home:'M3 10l9-7 9 7v10H3z', message:'M4 4h16v13H9l-5 4z', bell:'M5 17h14l-2-5V8a5 5 0 0 0-10 0v4zM10 21h4', chain:'M10 13a5 5 0 0 0 7.1.4l1.8-1.8a5 5 0 0 0-7-7L10.5 6M14 11a5 5 0 0 0-7.1-.4l-1.8 1.8a5 5 0 0 0 7 7L13.5 18', shield:'M12 3 5 6v6c0 4.2 2.8 6.8 7 8.5 4.2-1.7 7-4.3 7-8.5V6z', retrieval:'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5', doc:'M7 3h8l5 5v13H7zM15 3v5h5M10 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12.2 16.2 15 19', rocket:'M12 19c-4-1-6-5-6-9 3 0 6-3 7-6 1 3 4 6 7 6-1 4-3 8-8 9zM12 11h.01M8 17l-2 4M16 17l2 4' };
  paths.calendar = 'M5 5h14v16H5zM5 10h14M8 3v4M16 3v4';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] ?? paths.list}"/></svg>`;
};
let current: DemoSession | undefined;
let generation = 0;
let controller: AbortController | undefined;
let timeline = false;
let graph = false;
let graphSelection: string | undefined;
let railOpen = false;
let chatOpen = true;
let chatBusy = false;
let draft: ChatTurn[] = loadDraft();
/** Buyer turn shown as Pending while its request is in flight (or failed on the network and can be retried). */
let pendingTurn: { turn: ChatTurn; request: TurnRequest; why?: 'network' | 'server' | 'unsent' } | undefined;
let lastResult: { steps: TurnStep[]; outcome: TurnOutcome } | undefined;
/** Server-authoritative provider mode. `undefined` = not known (never rendered as live). */
let execution: ExecutionLabel | undefined;
let executionLoad: Promise<void> | undefined;
let capabilityLoad: Promise<void> | undefined;
let capabilities: PublicCapabilities | undefined;
let browserSession: BrowserSession | undefined;
let entrySuggestionBatch = 0;
let stopEntryRotation = () => {};
let entryPreparation: { demoId?: string } | undefined;
let entryViewTransition: ViewTransition | undefined;
let evaluations: EvaluationList | undefined;
let evaluation: EvaluationDetail | undefined;
let evaluationTab: 'Overview' | 'Questions' | 'Results' = 'Overview';
const evaluationTabKey = (id: string) => `tailor-eval-tab:${id}`;
let evalBusy = false;
let routingList: RoutingList | undefined;
let routingDetail: RoutingDetail | undefined;
let routingBusy=false;
let routingStep=0;
const routingDrafts=new Map<string,Record<string,string|string[]>>();
let turnNote = '';
let entryNotice = '';
let ended = false;
let restoreText = '';
let lastList: TraceList | undefined;
const collapsedRoots = new Set<string>();
const expanded = new Set<string>();
let returnTo = '';
let activeGuidance: { messageId: string; suggestion: GuidanceSuggestion; state: 'loading'|'shown'|'failed'; reason?: 'stale'|'missing'|'navigation'|'loading'|'render' } | undefined;
let guidanceAttempt = 0;
function guidanceCurrent(g: GuidanceSuggestion, s: DemoSession): boolean {
  return isCurrentGuidance(g,s);
}
function guidanceEvent(messageId: string, g: GuidanceSuggestion, outcome: 'selected'|'shown'|'failed'|'dismissed', reason?: 'stale'|'missing'|'navigation'|'loading'|'dismissed'|'render') {
  void request(`/api/sessions/${encodeURIComponent(String(g.binding.sessionId))}/guidance-events`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({messageId,suggestionId:g.id,outcome,...(reason?{reason}:{})}) }, true).catch(() => {});
}
function guidanceCards(turn: ChatTurn, s: DemoSession): string {
  if (s.story===null || !Array.isArray(turn.guidance) || !turn.guidance.length || turn.role !== 'tailor') return '';
  const guidance = sanitiseStoredGuidance(turn.guidance);
  if(!guidance.length)return '';
  const cards = guidance.map(g => {
    const stale = !guidanceCurrent(g,s);
    const selected = activeGuidance?.messageId === turn.id && activeGuidance.suggestion.id === g.id;
    return `<button type="button" class="contextual-suggestion" data-guidance-id="${esc(g.id)}" data-guidance-message="${esc(turn.id)}" aria-pressed="${selected}" ${stale?'disabled':''}><span class="contextual-suggestion-symbol" aria-hidden="true">↗</span><span><strong>${esc(g.label)}</strong><small>${esc(g.purpose)}</small></span><span class="contextual-suggestion-arrow" aria-hidden="true">›</span></button>`;
  }).join('');
  const stale = guidance.every(g => !guidanceCurrent(g,s));
  const a = activeGuidance?.messageId === turn.id ? activeGuidance : undefined;
  const note = a ? `<div class="contextual-guide-note${a.state==='failed'?' is-recovery':''}" role="status"><div><span>${a.state==='shown'?'Showing in your playground':a.state==='loading'?'Opening the relevant area':'Suggestion unavailable'}</span><button type="button" data-guidance-dismiss aria-label="Dismiss highlight">×</button></div><strong>${esc(a.suggestion.label)}</strong><p>${esc(a.state==='shown'?a.suggestion.purpose:a.state==='loading'?'Keeping your conversation here while the area loads.':a.reason==='stale'?'This suggestion is no longer current. Ask Tailor about the current scenario.':'That area is unavailable here. Explore the current trace or ask Tailor again.')}</p></div>` : '';
  return `<section class="contextual-suggestions" aria-label="Contextual suggestions"><div class="contextual-suggestion-heading"><span>Take a closer look</span><small>${stale?'Scenario changed':'Choose what’s useful'}</small></div>${cards}${stale?'<p class="contextual-stale">Ask Tailor again for suggestions about the current scenario.</p>':''}${note}</section>`;
}
function clearGuidance(reason: 'navigation'|'dismissed' = 'dismissed', focus = true) {
  const a = activeGuidance; activeGuidance = undefined; guidanceAttempt++;
  root.querySelectorAll('.contextual-guide-target').forEach(el => el.classList.remove('contextual-guide-target'));
  if(a) guidanceEvent(a.messageId,a.suggestion,'dismissed',reason);
  if(focus && a) { repaint(); [...root.querySelectorAll<HTMLElement>('[data-guidance-id]')].find(el=>el.dataset.guidanceId===a.suggestion.id && el.dataset.guidanceMessage===a.messageId)?.focus(); }
}
function restoreGuidanceHighlight() {
  const a = activeGuidance; if (!a || a.state !== 'shown' || !current) return;
  const unavailable = (reason: 'stale'|'missing') => {
    a.state='failed'; a.reason=reason; guidanceEvent(a.messageId,a.suggestion,'failed',reason);
    // This check runs after painting. Repaint the note too so it cannot retain a stale "shown" claim.
    queueMicrotask(() => { if(activeGuidance === a && a.state === 'failed') repaint(); });
  };
  if (!guidanceCurrent(a.suggestion,current)) { unavailable('stale'); return; }
  const g=a.suggestion;
  if (location.pathname !== (g.targetId==='alerts.overview'?routingBase(current.id):g.targetId==='evals.overview'?evalBase(current.id):`${base(current.id)}/${g.binding.traceId}`)) { clearGuidance('navigation',false); return; }
  const target = g.binding.spanId ? [...root.querySelectorAll<HTMLElement>('[data-span-id]')].find(el=>el.dataset.spanId===g.binding.spanId) : root.querySelector<HTMLElement>(g.targetId==='alerts.overview'?'.routing-create':g.targetId==='evals.overview'?'.eval-create':g.targetId==='trace.output'?'.root-output':'.steps');
  if(target && target.getClientRects().length) target.classList.add('contextual-guide-target');
  else unavailable('missing');
}
async function showGuidance(messageId: string, suggestionId: string) {
  const s=current; const turn=s?.conversation.find(t=>t.id===messageId); const g=sanitiseStoredGuidance(turn?.guidance).find(g=>g.id===suggestionId);
  if(!s || s.story===null || !g) return;
  const attempt=++guidanceAttempt; activeGuidance={messageId,suggestion:g,state:'loading'};
  guidanceEvent(messageId,g,'selected');
  const fail=(reason:'stale'|'missing'|'navigation'|'loading'|'render') => { if(attempt!==guidanceAttempt)return;activeGuidance={messageId,suggestion:g,state:'failed',reason};guidanceEvent(messageId,g,'failed',reason);repaint(); };
  if(!guidanceCurrent(g,s)) {fail(g.binding.version!==s.version || g.binding.scenario!==s.dataset.activeScenario?'stale':'missing');return;}
  const trace=s.dataset.traces.find(t=>t.id===g.binding.traceId && t.sessionId===s.id);
  const span=g.binding.spanId?trace?.spans.find(x=>x.id===g.binding.spanId):undefined;
  const allowed=['trace.overview','trace.slowest-span','trace.model-call','trace.output','evals.overview','alerts.overview'];
  if(!trace || !allowed.includes(g.targetId) || (g.binding.spanId && !span) || (g.targetId==='trace.model-call' && span?.kind!=='LLM') || (['trace.slowest-span','trace.model-call'].includes(g.targetId) && !span)) {fail('missing');return;}
  const original=openTrace(s);
  if(g.binding.openTraceId && original && original.id!==g.binding.openTraceId && original.id!==g.binding.traceId) {fail('stale');return;}
  chatOpen=true;sessionStorage.removeItem(chatKey(s.id));
  repaint();
  if(span) {expanded.add(span.id);for(const id of selectedSpanAncestors(trace,span.id))collapsedRoots.delete(id);}
  const path=g.targetId==='alerts.overview'?routingBase(s.id):g.targetId==='evals.overview'?evalBase(s.id):`${traceLink(trace)}${span?'?span='+encodeURIComponent(span.id):''}`;
  // Repeating a suggestion reopens its target without adding another Back stop.
  const rendered=await (location.pathname+location.search===path ? render() : navigate(path));
  if(attempt!==guidanceAttempt)return;
  if(!rendered || !current || !guidanceCurrent(g,current)) {fail('stale');return;}
  const target=span?[...root.querySelectorAll<HTMLElement>('[data-span-id]')].find(el=>el.dataset.spanId===span.id):root.querySelector<HTMLElement>(g.targetId==='alerts.overview'?'.routing-create':g.targetId==='evals.overview'?'.eval-create':g.targetId==='trace.output'?'.root-output':'.steps');
  if(!target || !target.isConnected || !target.getClientRects().length) {fail('missing');return;}
  activeGuidance={messageId,suggestion:g,state:'shown'};repaint();restoreGuidanceHighlight();
  const shown=root.querySelector<HTMLElement>('.contextual-guide-target');
  if(!shown || !shown.getClientRects().length){fail('render');return;}
  shown.scrollIntoView({block:'center',behavior:'auto'});
  guidanceEvent(messageId,g,'shown');
  requestAnimationFrame(() => {
    const card=[...root.querySelectorAll<HTMLElement>('[data-guidance-id]')].find(el=>el.dataset.guidanceId===g.id && el.dataset.guidanceMessage===messageId);
    const thread=root.querySelector<HTMLElement>('.chat-panel .chat-thread');
    if(card && thread) thread.scrollTop=Math.max(0,card.offsetTop-thread.offsetTop-8);
  });
}

const link = (path: string,label: string,cls='')=>`<a data-nav href="${esc(path)}" class="${cls}">${label}</a>`;
const base = (id: string) => `/demo/${id}/traces`;
const traceLink = (t: Trace) => `${base(t.sessionId)}/${t.id}`;
const routingBase=(id:string)=>`/demo/${id}/alerts`;
const evalBase = (id: string) => `/demo/${id}/evals`;
const evalLink = (id: string, evaluationId: string) => `${evalBase(id)}/${evaluationId}`;
type PublicCapabilities = { version: string; verifiedOn: string; starters: { id: string; capabilityId: string; title: string; prompt: string }[]; capabilities: { id: string; title: string; scope: 'official_product'|'clone_only'; support: string; surfaces: string[]; limitations: string[]; hostedAvailability: string }[] };
function syntheticReviewQuestions(): EvaluationQuestion[] {
  return [
    { key: 'resolved', label: 'Did the output resolve the fictional request?', type: 'yes_no', required: true, reviewer: 'simulated_judge' },
    { key: 'quality', label: 'How useful and accurate is the answer?', type: 'rating', min: 1, max: 5, required: true, reviewer: 'buyer' },
    { key: 'notes', label: 'What should change?', type: 'text', required: false, reviewer: 'buyer' },
  ];
}
function historyDepth() {
  const state = history.state as { tailor?: unknown } | null;
  return state && typeof state.tailor === 'number' ? state.tailor : 0;
}
function navigate(path: string, preserveEntry = false): Promise<boolean> { history.pushState({ tailor: historyDepth() + 1 },'',path); return render(preserveEntry); }
function durationLabel(ms: number) { return ms < 1 ? `${Math.round(ms * 1000)}µs` : `${ms}ms`; }
function ingested(iso: string) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',hour12:true}).format(d).replace(/\u202f/g,' ');
  const month = new Intl.DateTimeFormat('en-US',{month:'short'}).format(d);
  const day = d.getDate();
  const teen = day % 100;
  const suffix = teen >= 11 && teen <= 13 ? 'th' : (['th','st','nd','rd'][day % 10] ?? 'th');
  return { time, date: `${month} ${day}`, heading: `${day}${suffix} ${month}, ${time}` };
}
const kindMark = (kind: Span['kind']) => kind === 'CHAIN' ? 'chain' : kind === 'GUARDRAIL' ? 'shield' : kind === 'RETRIEVAL' ? 'retrieval' : kind === 'WORKFLOW' ? 'tree' : 'tool';
const kindClass = (kind: Span['kind']) => kind === 'WORKFLOW' || kind === 'CHAIN' ? 'kind-filled' : 'kind-light';
class ApiFailure extends Error {
  code: string; status: number;
  constructor(code: string, status: number, message: string) { super(`${code}: ${message}`); this.code = code; this.status = status; }
}
const isEnded = (e: unknown) => e instanceof ApiFailure && (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_ENDED' || e.status === 410);
const SESSION_KEYS = ['tailor-draft-chat', 'creation-operation', 'creation-payload', 'creation-turn-id', 'tailor-pending-turn'];
const stepsKey = (id: string) => `tailor-steps:${id}`;
function clearLocalState() {
  for (const key of SESSION_KEYS) sessionStorage.removeItem(key);
  // `tailor-exec:` is a legacy key (provider mode used to be cached per tab); it is no longer read.
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('tailor-chat-collapsed:') || key.startsWith('tailor-exec:') || key.startsWith('tailor-steps:') || key.startsWith('tailor-entry-awaiting:') || key.startsWith('tailor-auto-guidance:')) sessionStorage.removeItem(key);
  activeGuidance=undefined;guidanceAttempt++;
  draft = []; pendingTurn = undefined; lastResult = undefined; turnNote = ''; chatBusy = false; current = undefined; lastList = undefined;
}
function showEnded() {
  stopEntryRotation();
  entryViewTransition?.skipTransition();
  entryViewTransition = undefined;
  document.documentElement.classList.remove('entry-view-transition');
  entryPreparation = undefined;
  ended = true; generation++; controller?.abort();
  clearLocalState();
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  root.innerHTML = `<main class="ended" role="alert"><h1>This demo has ended</h1><p>Your conversation and demo data were deleted. Nothing from this session is kept.</p>${link('/entry','Start a new demo','solid')}</main>`;
}
/** Friendly page for a demo this browser cannot open (ended, expired in another tab, or someone else's). No raw codes. */
function showUnavailable() {
  current=undefined;activeGuidance=undefined;guidanceAttempt++;
  stopEntryRotation();
  entryViewTransition?.skipTransition();
  entryViewTransition = undefined;
  document.documentElement.classList.remove('entry-view-transition');
  entryPreparation = undefined;
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  root.innerHTML = `<main class="ended request-error"><h1>Demo unavailable</h1><p role="alert">This demo isn’t available in this browser. It may have ended or expired, or it was started somewhere else.</p>${link('/entry','Start a new demo','solid')}</main>`;
}
const plain = (message: string) => message.replace(/^[A-Z][A-Z_]+: /, '');
async function request<T>(path: string, init: RequestInit = {}, durable = false): Promise<T> {
  const response = await fetch(path, durable ? init : {...init,signal:controller?.signal});
  let data: any = null;
  try { data = await response.json(); } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const failure = new ApiFailure(data?.error?.code ?? String(response.status), response.status, data?.error?.message ?? 'Request failed.');
    const failedDemo = /^\/api\/sessions\/([^/]+)/.exec(path)?.[1];
    if (isEnded(failure) && (!failedDemo || location.pathname.startsWith(`/demo/${failedDemo}/`))) showEnded();
    throw failure;
  }
  return data as T;
}
const io = (value: Json) => value && typeof value==='object' && !Array.isArray(value)
  ? Object.entries(value).map(([k,v])=>`${esc(k)}: ${esc(typeof v==='object' ? JSON.stringify(v) : v)}`).join('<br>') : esc(JSON.stringify(value));
function activeLabel(s: DemoSession) {
  return s.dataset.traces.find(t => t.scenario === s.dataset.activeScenario)?.label ?? s.dataset.activeScenario;
}
function notice(s: DemoSession) {
  return `<div class="demo-notice">Synthetic demo · Powered by Tailor · v${s.version} · ${s.story ? esc(activeLabel(s)) : 'sample data, not your agent yet'}</div>`;
}
function loadDraft(): ChatTurn[] {
  try { const parsed = JSON.parse(sessionStorage.getItem('tailor-draft-chat') ?? '[]') as ChatTurn[]; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveDraft(turns: ChatTurn[]) { draft = turns; sessionStorage.setItem('tailor-draft-chat', JSON.stringify(turns)); }
function chatKey(id: string) { return `tailor-chat-collapsed:${id}`; }
function turnsOf(s?: DemoSession): ChatTurn[] {
  const base = s ? s.conversation : draft;
  if (!s || !pendingTurn) return base;
  if (base.some(t => t.id === pendingTurn!.turn.id)) return base;
  const last = base[base.length - 1];
  // The server may already hold this buyer turn (a read during the request); show our status, not a second bubble.
  if (last && last.role === 'buyer' && last.text === pendingTurn.turn.text) return base.map((t, i) => i === base.length - 1 ? { ...t, status: pendingTurn!.turn.status } : t);
  return [...base, pendingTurn.turn];
}
function loadExecution(): Promise<void> {
  if (execution) return Promise.resolve();
  executionLoad ??= (async () => {
    try {
      const response = await fetch('/api/execution', { cache: 'no-store' });
      if (!response.ok) throw new Error('status');
      const label = ((await response.json()) as Partial<ExecutionInfoResponse>).execution;
      if (label && (label.mode === 'mock' || label.mode === 'live')) execution = label;
    } catch { /* stays unknown: the UI says so instead of guessing */ }
    finally { executionLoad = undefined; paintExecution(); }
  })();
  return executionLoad;
}
function loadCapabilities(): Promise<void> {
  if (capabilities) return Promise.resolve();
  capabilityLoad ??= (async () => {
    try {
      const response = await fetch('/api/capabilities', { cache: 'no-store' });
      if (!response.ok) throw new Error('status');
      const payload = (await response.json()) as Partial<PublicCapabilities>;
      if (Array.isArray(payload.starters) && Array.isArray(payload.capabilities)) {
        capabilities = { version: String(payload.version ?? ''), verifiedOn: String(payload.verifiedOn ?? ''), starters: payload.starters.slice(0, 3), capabilities: payload.capabilities } as PublicCapabilities;
      }
    } catch { /* starter ideas are optional; never invent a capability when the projection is unavailable */ }
    finally {
      capabilityLoad = undefined;
      paintStarters();
    }
  })();
  return capabilityLoad;
}
async function loadBrowserSession(): Promise<void> {
  try { browserSession = await request<BrowserSession>('/api/browser-session', { cache: 'no-store' } as RequestInit, true); }
  catch { browserSession = undefined; }
  paintSavedDemos();
}
function savedDemoButtons() {
  return entrySavedState(browserSession).demos.map(d=>`<button type="button" data-select-demo="${esc(d.id)}">${esc(d.label)} · v${d.version}</button>`).join('');
}
function paintSavedDemos() {
  const target=document.querySelector<HTMLElement>('[data-saved-demos]');
  const saved = entrySavedState(browserSession);
  if(target) { target.innerHTML=savedDemoButtons(); target.closest<HTMLElement>('.saved-demos')!.hidden = !saved.demos.length; }
  const resume = document.querySelector<HTMLButtonElement>('#resume');
  if (resume) resume.hidden = !saved.activeDemo;
}
function paintStarters() {
  const target = document.querySelector<HTMLElement>('[data-starter-list]');
  if (target) {
    const entry = target.classList.contains('entry-suggestions');
    if (entry) stopEntryRotation();
    target.innerHTML = entry ? entrySuggestionButtons() : starterButtons();
    if (entry) startEntryRotation();
  }
}
function entrySuggestionButtons() {
  return suggestionBatch(entrySuggestions(capabilities), entrySuggestionBatch).map(x => `<div class="suggestion-row"><button type="button" data-example="${esc(x.prompt)}" data-capability-id="${esc(x.capabilityId)}">${x.lead ? `<span class="suggestion-lead">${esc(x.lead)}</span> ` : ''}${esc(x.text)}</button></div>`).join('');
}
function startEntryRotation() {
  const target = document.querySelector<HTMLElement>('.entry-suggestions');
  const stage = target?.closest<HTMLElement>('.chat-stage');
  if (!target || !stage) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let phaseTimer: number | undefined;
  let animations: Animation[] = [];
  let stopped = false;
  let pressed = false;
  const settle = () => {
    if (phaseTimer !== undefined) window.clearTimeout(phaseTimer);
    phaseTimer = undefined;
    animations.forEach(animation => animation.cancel());
    animations = [];
    delete target.dataset.rotating;
  };
  const blocked = () => stopped || pressed || !target.isConnected || location.pathname !== '/entry' ||
    reducedMotion.matches || document.hidden || !visible || stage.matches(':hover') ||
    stage.contains(document.activeElement) || chatBusy ||
    !!stage.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.value.trim();
  const animateRows = (enter: boolean) => {
    const rows = target.querySelectorAll<HTMLElement>('.suggestion-row');
    for (const [index,row] of rows.entries()) {
      if (typeof row.animate !== 'function') continue;
      animations.push(row.animate(enter ? [
        { transform:'translateY(20px)', opacity:0, filter:'blur(4px)' },
        { transform:'translateY(0)', opacity:1, filter:'blur(0px)' },
      ] : [
        { transform:'translateY(0)', opacity:1, filter:'blur(0px)' },
        { transform:'translateY(-20px)', opacity:0, filter:'blur(4px)' },
      ], {duration:enter?380:240,delay:index*(enter?45:35),easing:'cubic-bezier(0.16,1,0.3,1)',fill:'both'}));
    }
  };
  const timer = window.setInterval(() => {
    if (!target.isConnected || location.pathname !== '/entry') { stopEntryRotation(); return; }
    if (blocked() || target.dataset.rotating || entrySuggestions(capabilities).length <= 3) return;
    target.dataset.rotating = 'out';
    animateRows(false);
    phaseTimer = window.setTimeout(() => {
      if (blocked()) { settle(); return; }
      settle();
      entrySuggestionBatch++;
      target.innerHTML = entrySuggestionButtons();
      target.dataset.rotating = 'in';
      animateRows(true);
      phaseTimer = window.setTimeout(settle,470);
    },310);
  },8000);
  // Interrupt immediately so a clicked/focused question never changes beneath the user.
  stage.addEventListener('mouseenter',settle);
  stage.addEventListener('focusin',settle);
  stage.addEventListener('input',settle);
  const pointerPressed = () => { pressed = true; settle(); };
  const pointerReleased = () => { pressed = false; };
  stage.addEventListener('pointerdown',pointerPressed);
  window.addEventListener('pointerup',pointerReleased);
  window.addEventListener('pointercancel',pointerReleased);
  const preferenceChanged = () => { if (reducedMotion.matches) settle(); };
  const visibilityChanged = () => { if (document.hidden) settle(); };
  reducedMotion.addEventListener('change',preferenceChanged);
  document.addEventListener('visibilitychange',visibilityChanged);
  const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (!visible) settle(); });
  observer.observe(target);
  stopEntryRotation = () => {
    stopped = true;
    window.clearInterval(timer);
    settle();
    observer.disconnect();
    stage.removeEventListener('mouseenter',settle);
    stage.removeEventListener('focusin',settle);
    stage.removeEventListener('input',settle);
    stage.removeEventListener('pointerdown',pointerPressed);
    window.removeEventListener('pointerup',pointerReleased);
    window.removeEventListener('pointercancel',pointerReleased);
    reducedMotion.removeEventListener('change',preferenceChanged);
    document.removeEventListener('visibilitychange',visibilityChanged);
    stopEntryRotation = () => {};
  };
}
const sameExecution = (a: ExecutionLabel | undefined, b: ExecutionLabel | undefined) =>
  !!a && !!b && a.mode === b.mode && a.provider === b.provider && (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null);
const execChip = () => execution?.mode === 'mock' ? 'Mock-backed' : execution?.mode === 'live' ? `Live model${execution.model ? ` · ${execution.model}` : ''}` : 'Provider status unavailable';
/** Updates the label in place so typing in the composer is never disturbed. */
function paintExecution() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-exec-chip]')) el.textContent = execChip();
}
/** Buyer-facing wording only: the knowledge base uses internal terms (repo paths, "clone", "slice", "explain-only"). */
function buyerText(text: string) {
  const matchCase = (word: string, replacement: string) => word[0] === word[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
  return text
    .replace(/repo:[\w./-]+/g, 'product knowledge')
    .replace(/\bexplain-only\b/gi, w => matchCase(w, 'view-only'))
    .replace(/\b(the|this|a) (?:clone|slice)\b/gi, (_w, article: string) => `${article} demo`)
    .replace(/\bclone\b/gi, w => matchCase(w, 'demo'));
}
function openTrace(s?: DemoSession): Trace | undefined {
  const match = /^\/demo\/[^/]+\/traces\/([^/]+)$/.exec(location.pathname);
  return s && match ? s.dataset.traces.find(t => t.id === match[1]) : undefined;
}
function shell(s: DemoSession,content: string) {
  document.documentElement.classList.toggle('rail-open', railOpen);
  document.documentElement.classList.toggle('chat-dock', chatOpen);
  const quiet = (name: string) => `<button type="button" class="rail-button" data-unavailable aria-label="${name} — outside this demo">${icon(name)}</button>`;
  const labeled = (name: string, label: string, extra = '') => `<button type="button" class="rail-button" data-unavailable aria-label="${label} — outside this demo">${icon(name)}<span class="rail-label">${label}</span>${extra}</button>`;
  const traces = link(base(s.id), `${icon('list')}<span class="rail-label">traces</span>`, 'rail-button selected');
  const collapsed = `${['message','tree','home','tool'].map(quiet).join('')}${link(base(s.id), icon('list'), 'rail-button selected')}${['search','bell'].map(quiet).join('')}`;
  const activeDemo = browserSession?.demos.find(d => d.id === s.id);
  const demoPicker = browserSession?.demos.length ? `<details class="demo-picker"><summary aria-label="Choose demo">${esc(activeDemo?.label ?? 'Your demos')}</summary><nav aria-label="Your demos">${browserSession.demos.map(d => `<button type="button" data-select-demo="${esc(d.id)}" ${d.id === s.id ? 'aria-current="page"' : ''}>${esc(d.label)} <small>v${d.version}</small></button>`).join('')}</nav></details>` : '';
  const expanded = `<div class="rail-switch"><button type="button" data-unavailable>console</button><button type="button" data-chat-open>chats</button></div>${demoPicker}<div class="rail-project"><span>Fictional demo</span></div>${labeled('rocket','setup','<em>1/2</em>')}<nav class="rail-menu" aria-label="Project">${labeled('home','home')}${labeled('bell','incidents')}${traces}${labeled('tool','detections')}${link(routingBase(s.id),`${icon('bell')}<span class="rail-label">alerts</span>`,'rail-button')}<a data-nav href="${esc(evalBase(s.id))}" class="rail-button${location.pathname.includes('/evals')?' selected':''}">${icon('check')}<span class="rail-label">evals</span></a>${labeled('tree','analytics')}${labeled('search','search')}${labeled('tool','experiments','<em>beta</em>')}</nav>`;
  const opener = chatOpen ? '' : `<div class="chat-reopen"><button type="button" data-chat-open>Open conversation</button><button type="button" data-end-demo class="end-demo">End demo</button></div>`;
  return `<aside class="rail${railOpen?' is-labeled':''}"><div class="rail-header"><a data-nav href="/" class="mark" aria-label="Landing page">n</a><button type="button" class="rail-toggle" data-rail aria-expanded="${railOpen}" aria-label="${railOpen?'Collapse sidebar':'Expand sidebar'}">${icon(railOpen?'back':'chevron')}</button></div><div class="rail-collapsed-only">${collapsed}</div>${railOpen?expanded:''}<div class="rail-bottom"><button data-theme aria-label="Toggle local theme">${icon('sun')}</button></div></aside><div class="workspace">${opener}${content}</div>${chatOpen ? chatPanel(s) : ''}`;
}
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', applied: 'Applied', failed: 'Failed', uncertain: 'Uncertain', question: 'Question' };
function statusLabel(turn: ChatTurn, next?: ChatTurn) {
  if (turn.role === 'buyer') {
    if (pendingTurn && pendingTurn.turn.id === turn.id) {
      if (pendingTurn.why === 'unsent') return 'Not sent';
      if (pendingTurn.why === 'server') return 'Unconfirmed';
    }
    // A request Tailor declined (refusal) is saved as failed with an informational reply; it is not an error.
    if (turn.status === 'failed' && next?.role === 'tailor' && next.status === 'note') return 'Declined';
    return STATUS_LABEL[turn.status] ?? '';
  }
  return turn.status === 'question' || turn.status === 'uncertain' ? STATUS_LABEL[turn.status]! : '';
}
function assistantReply(text: string, groupReferences: boolean): string {
  const prose = (block: ReplyTextBlock) => block.kind === 'paragraph' ? `<p>${esc(block.text)}</p>` : `<ul class="reply-points">${block.items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`;
  return `<div class="assistant-reply">${replyBlocks(buyerText(text), {groupReferences}).map(block=>{
    if(block.kind === 'steps') return `<ol class="reply-steps" start="${block.start}">${block.items.map(item=>`<li><strong class="reply-step-title">${esc(item.title)}</strong>${item.body.map(prose).join('')}</li>`).join('')}</ol>`;
    if(block.kind === 'references') return `<details class="reply-reference"><summary>${block.unknownPlans ? 'Sources · plan availability unverified' : 'Sources and plan availability'}</summary>${block.lines.map(line=>`<p>${esc(line)}</p>`).join('')}</details>`;
    return prose(block);
  }).join('')}</div>`;
}
function chatThread(turns: ChatTurn[], s?: DemoSession) {
  const trimmed = s?.conversationTruncated ? `<p class="chat-trimmed" role="note">Older messages were trimmed</p>` : '';
  const lastIndex = turns.length - 1;
  return trimmed + turns.map((turn, i) => {
    const label = statusLabel(turn, turns[i + 1]);
    const evidenceLinks = (e: NonNullable<ChatTurn['evidence']>) => [...new Set(e.traceIds)].slice(0, 2).map(id => {
      const found = s!.dataset.traces.find(t => t.id === id);
      return link(`${base(s!.id)}/${id}`, esc(found?.label ?? 'open trace'));
    });
    const evidence = turn.evidence && s ? `<small class="chat-evidence">Evidence · v${turn.evidence.version} · ${evidenceLinks(turn.evidence).join(' · ')}${turn.evidence.spanIds.length ? ` · ${turn.evidence.spanIds.length} ${turn.evidence.spanIds.length === 1 ? 'step' : 'steps'} cited` : ''}</small>` : '';
    const confirmationRef = turn.clarification?.kind === 'demo_switch' ? turn.clarification.referenceId : undefined;
    const choiceGroup = turn.clarification?.kind === 'demo_switch' ? 'Choose how to handle this workflow change' : 'Choose one';
    const choices = turn.clarification && i === lastIndex ? `<div class="chat-choices" role="group" aria-label="${esc(choiceGroup)}">${turn.clarification.choices.map(c => `<button type="button" data-choice="${esc(c.id)}" ${confirmationRef ? `data-confirmation-ref="${esc(confirmationRef)}"` : ''} ${chatBusy ? 'disabled' : ''}>${esc(c.label)}</button>`).join('')}</div><small>or type your own answer below</small>` : '';
    const retry = pendingTurn && pendingTurn.turn.id === turn.id && (turn.status === 'failed' || turn.status === 'uncertain') && !chatBusy ? `<button type="button" class="chat-retry" data-retry-turn>Retry</button>` : '';
    return `<article class="chat-turn is-${turn.role}${turn.status === 'uncertain' ? ' is-uncertain' : ''}" data-status="${turn.status}"${label === 'Declined' ? ' data-declined' : ''}>${turn.role === 'tailor' ? `${s?'<div class="contextual-answer-identity"><span aria-hidden="true">✳</span><small>Tailor</small></div>':''}${assistantReply(turn.text, !turn.evidence)}` : `${s?'<div class="contextual-question-label">Your question</div>':''}<p>${esc(turn.text)}</p>`}${label ? `<small class="turn-status">${label}</small>` : ''}${retry}${evidence}${choices}${s?guidanceCards(turn,s):''}</article>`;
  }).join('');
}
function progress() {
  if (chatBusy) return `<p class="chat-steps is-working" role="status" aria-live="polite"><span class="chat-pending-indicator" aria-hidden="true"></span>Working on your request…</p>`;
  const line = lastResult ? turnSummary(lastResult.steps, lastResult.outcome) : '';
  const uncertain = lastResult?.outcome === 'readback_uncertain';
  return `${turnNote ? `<p class="chat-note${uncertain ? ' is-uncertain' : ''}" role="status">${esc(turnNote)}</p>` : ''}${line ? `<p class="chat-steps" aria-label="Latest request">${esc(line)}</p>` : ''}`;
}
function composer(busy: boolean, asking?: Trace) {
  const text = restoreText; restoreText = '';
  const about = asking ? `<p class="chat-asking" data-asking-about="${esc(asking.id)}" title="${esc(asking.id)}">Asking about: ${esc(asking.label)}</p>` : '';
  return `<form id="chat-form" class="chat-composer">${about}<textarea name="message" aria-label="Ask anything" placeholder="Describe your agent or ask a question…" maxlength="2000" rows="2" ${busy?'disabled':''}>${esc(text)}</textarea><div class="chat-tools"><span class="chat-chip">Synthetic data</span><span class="chat-chip" data-exec-chip>${esc(execChip())}</span><button type="submit" aria-label="Send message" ${busy?'disabled':''}>${icon('chevron')}</button></div></form>`;
}
/** Starter prompts are a public projection of executable capabilities; they fill the composer and never send. */
function starterButtons() {
  return (capabilities?.starters ?? []).slice(0, 3).map(x => `<button type="button" data-example="${esc(x.prompt)}" data-capability-id="${esc(x.capabilityId)}">${esc(x.title || x.prompt)}</button>`).join('');
}
function starterExamples() { return `<div class="chat-examples" data-starter-list aria-label="Capability-backed starter prompts">${starterButtons()}</div>`; }
function examples(s: DemoSession | boolean) {
  if (typeof s === 'boolean' || s.story === null) return starterExamples();
  const relevantTrace = openTrace(s) ?? s.dataset.traces.find(t => t.scenario === s.dataset.activeScenario) ?? s.dataset.traces[0];
  const hasRetry = !!relevantTrace?.spans.some(span => /retry|backoff|attempt[_ -]?(?:[2-9]|\d{2,})\b/i.test(span.name));
  return `<div class="chat-examples" aria-label="Suggested prompts"><button type="button" data-example="Explain this trace">Explain this trace</button>${hasRetry ? '<button type="button" data-example="Make the retry fail too">Make the retry fail too</button>' : ''}</div>`;
}
function payloadCaptureStatus(s: DemoSession): string {
  const value=(s as DemoSession & {payloadCapture?:unknown}).payloadCapture;
  const status=value && typeof value==='object'?value as Record<string,unknown>:undefined;
  const enabled=status?.enabled===true && status.reason==='approved_synthetic_session' && Number.isSafeInteger(status.maxTextChars) && Number(status.maxTextChars)>0 && Number(status.maxTextChars)<=2000;
  const explanation=enabled?'Approved synthetic session: bounded trace text capture is on, up to 2,000 characters per text field.'
    :status?.reason==='session_not_approved'?'Trace text capture is off because this session has not been approved. Timing and token usage are still recorded.'
    :status?.reason==='hosted_export_disabled'?'Hosted trace text capture is off in this local preview.'
    :'Trace text capture is off. Capture approval for this session is unavailable.';
  return `<details class="payload-capture-status" data-payload-capture="${enabled?'on':'off'}"><summary title="${esc(explanation)}">Trace text capture ${enabled?'on':'off'} <span aria-hidden="true">ⓘ</span></summary><p>${esc(explanation)}</p></details>`;
}
function chatPanel(s: DemoSession) {
  const turns = turnsOf(s);
  return `<aside class="chat-panel${activeGuidance?' has-contextual-guidance':''}" aria-label="Playground"><header><span class="contextual-tailor-mark" aria-hidden="true">✳</span><div class="playground-heading"><strong>Tailor</strong><span class="contextual-tailor-subtitle">Explore this product with me</span></div><span class="chat-actions"><button type="button" data-end-demo class="end-demo">End demo</button><button type="button" data-chat-collapse aria-label="Collapse conversation">${icon('close')}</button></span></header><div class="chat-thread">${turns.length?chatThread(turns, s):`<p class="chat-empty">Describe the agent you’re building, or ask me to explain the open trace.</p>`}${progress()}</div><footer class="contextual-conversation-footer">${examples(s)}${composer(chatBusy, openTrace(s))}${payloadCaptureStatus(s)}<div class="contextual-powered">Powered by Tailor <span>Synthetic data · ${esc(execChip())}</span></div></footer></aside>`;
}
function landing() {
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  const item = (n: string) => n === 'Manifesto'
    ? `<button data-unavailable class="nav-current"><i class="nav-dot" aria-hidden="true"></i>${n}</button>`
    : n === 'Product' ? `<button data-unavailable class="nav-caret">${n}</button>`
    : n === 'Docs' ? `<button data-unavailable class="nav-out">${n}</button>`
    : `<button data-unavailable>${n}</button>`;
  root.innerHTML = `<div class="landing"><div class="hack"><span class="hack-date">Oct 10–12</span> Join neatHack · $19,000 in prizes & credits ↗</div><header class="public-nav">${link('/','neatlogs','wordmark')}<nav>${['Manifesto','Product','Pricing','Docs','Blog','Changelog','Careers'].map(item).join('')}<span class="nav-rule" aria-hidden="true"></span>${link('/entry','Explore the demo ↗','solid')}</nav></header><main class="hero"><picture><source media="(max-width:600px)" srcset="/assets/portrait.webp"><img src="/assets/landscape.webp" alt="San Francisco skyline and bridge in silver fog"></picture><div class="hero-copy"><h1><span>See where your agent workflow can fail.</span><br>Explore it with Tailor</h1><p>Describe a fictional workflow, inspect its synthetic traces, and ask Tailor to explain or change the demo.</p><div class="hero-actions">${link('/entry','Explore the demo ↗','outline')}</div></div></main><footer class="landing-foot">Tailor proof of concept · fictional workflows and synthetic traces. ${link('/entry','Start a demo')}</footer></div>`;
}
function entry() {
  stopEntryRotation();
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  void loadExecution();
  void loadCapabilities();
  const turns = draft;
  const started = turns.length > 0;
  const banner = entryNotice ? `<p class="entry-notice" role="status">${esc(entryNotice)}</p>` : '';
  const saved = entrySavedState(browserSession);
  const savedDemos = `<section class="saved-demos" ${saved.demos.length ? '' : 'hidden'}><h2>Your saved demos</h2><div data-saved-demos>${savedDemoButtons()}</div></section>`;
  root.innerHTML = `<div class="chat-home"><header class="entry-nav">${link('/','neatlogs','wordmark')}${link('/','← Back to landing')}</header><div class="chat-stage${chatBusy ? ' is-preparing' : ''}">${banner}${started?`<div class="chat-thread">${chatThread(turns)}</div>`:`<div class="entry-intro"><h1>See your agent in action</h1><p>Explore a workflow. See what happens at every step.</p></div>`}${chatBusy?`<div class="entry-transition" role="status" aria-live="polite"><span class="entry-transition-mark" aria-hidden="true"></span><div><h1>Preparing your playground…</h1><p data-entry-phase>Creating your demo…</p></div></div>`:''}${composer(chatBusy)}<div class="chat-examples entry-suggestions" data-starter-list aria-label="Suggested workflow questions">${entrySuggestionButtons()}</div><p class="tailor-attribution">Powered by <span class="tailor-pill">Tailor</span></p>${savedDemos}${started?`${turns[turns.length-1]!.status==='failed'?`<button type="button" data-retry-draft>Retry</button> `:''}<button type="button" data-discard-draft>Discard draft</button>`:`<button type="button" id="resume" ${saved.activeDemo ? '' : 'hidden'}>Resume this browser’s saved session</button>`}<p class="form-error" role="alert"></p></div></div>`;
  startEntryRotation();
}
const traceGuideKey = (id: string) => `tailor-trace-guide:${id}`;
function guideDismissed(id: string) { try { return sessionStorage.getItem(traceGuideKey(id)) === 'dismissed'; } catch { return false; } }
function guidedTraceLink(t: Trace) {
  const span = traceGuideFacts(t).recommendedSpan;
  return `${traceLink(t)}${span ? `?span=${encodeURIComponent(span.id)}` : ''}`;
}
function traceGuide(s: DemoSession, traces: Trace[], detailTrace?: Trace, selected?: string | null) {
  if (guideDismissed(s.id)) return `<div class="trace-guide-reopen"><button type="button" data-trace-guide-show>Show guide</button></div>`;
  const target = detailTrace ?? recommendedTrace(traces, s.dataset.activeScenario);
  const facts = target ? traceGuideFacts(target) : undefined;
  const span = facts?.recommendedSpan;
  const sample = s.story === null ? 'These are sample traces, not a workflow built from your request. ' : 'These are synthetic traces of your fictional workflow. ';
  const description = detailTrace
    ? `${sample}Read the input, inspect ${span ? `“${span.name}”${span.status === 'ERROR' ? ' (marked ERROR)' : ''}` : 'a saved step'}, then compare the output. Ready means processed, not that the task succeeded.`
    : `${sample}Ready means processed, not that the task succeeded. ${facts?.stepErrors ? 'Start with a trace that contains a step marked ERROR; it may still recover afterward.' : target ? 'Open a trace to inspect its saved steps, input and output.' : 'Adjust your filters to find a trace to inspect.'}`;
  const spanVisible = target && span && selectedSpanAncestors(target, span.id).every(id => !collapsedRoots.has(id));
  const inspect = target && (!detailTrace || (span && (!spanVisible || (selected !== span.id && !expanded.has(span.id)))))
    ? link(guidedTraceLink(target), `Inspect ${esc(detailTrace ? span!.name : target.label)}`, 'trace-start-link') : '';
  return `<section class="trace-guide${detailTrace ? ' is-compact trace-detail-guide' : ''}" aria-label="Trace guide"><div class="guide-copy"><h2>${detailTrace ? 'Inspect a step' : 'Start with a trace'}</h2><p>${esc(description)}</p></div><div class="guide-actions">${inspect}${detailTrace ? '<button type="button" data-example="Explain this trace">Ask Tailor to explain this trace</button>' : ''}<button type="button" data-trace-guide-dismiss>Dismiss guide</button></div></section>`;
}
const TRACE_FIELD_HELP: Record<string, string> = {
  'Ingested at': 'The recorded ingestion time supplied by this synthetic demo. Its date range is fixed.',
  Status: 'Ready means the trace was processed. It does not mean the agent’s task succeeded.',
  Detections: 'Counts saved steps flagged as detections. Execution Failed is a step flag; a trace may recover afterward.',
  Evals: 'No evaluation result is attached to these rows. Evals opens a separate local synthetic review.',
  Input: 'The workflow label identifies the trace here. Open it to inspect its saved input.',
  Output: 'A preview of the saved output’s reported outcome, when present. Open the trace for its full output.',
  Comments: 'Comments are not implemented in this demo.',
  Replay: 'Replay is not implemented in this demo. This control does not rerun the workflow.',
};
function traceFieldHeader(label: string) {
  const id = `trace-help-${label.toLowerCase().replaceAll(' ', '-')}`;
  return `<th><span class="trace-help"><button type="button" aria-label="About ${esc(label)}" aria-describedby="${id}" popovertarget="${id}" title="${esc(TRACE_FIELD_HELP[label])}">${esc(label)}<span aria-hidden="true">?</span></button><span class="trace-tooltip" id="${id}" role="tooltip" popover="auto">${esc(TRACE_FIELD_HELP[label])}</span></span></th>`;
}
function awaitingPersonalisedDemo(s: DemoSession): boolean {
  return s.story === null && (sessionStorage.getItem(`tailor-entry-awaiting:${s.id}`) === '1' || !!pendingTurn || s.conversation.some(turn => turn.role === 'buyer'));
}
function preparationWorkspace(s: DemoSession) {
  const latestAnswer=[...s.conversation].reverse().find(turn=>turn.role==='tailor');
  const clarification=latestAnswer?.status==='question' && !!latestAnswer.clarification;
  const informational=latestAnswer?.status==='note' && !pendingTurn && !turnNote && (!lastResult || lastResult.outcome==='answered');
  const title=chatBusy?'Working on your workflow…':clarification?'A little more context is needed':informational?'Ask about your workflow':'Your workflow is not ready yet';
  const copy=chatBusy?'Tailor is handling your request. Your conversation stays here.':clarification?'Answer Tailor’s question to continue. No personalised traces have been saved yet.':informational?'Explore your workflow in the conversation. No personalised traces have been created.':'No personalised traces have been saved and verified. Check the conversation and try again when you’re ready.';
  root.innerHTML=shell(s,`<main class="personalised-preparation${chatBusy?' is-working':''}" role="status" aria-live="polite" aria-busy="${chatBusy}"><span class="personalised-preparation-mark" aria-hidden="true">✳</span><h1>${esc(title)}</h1><p>${esc(copy)}</p></main>`);
}
function list(s: DemoSession,data: TraceList) {
  if(awaitingPersonalisedDemo(s)){lastList=data;preparationWorkspace(s);return;}

  lastList = data;
  const query = new URLSearchParams(location.search);
  const recommended = guideDismissed(s.id) ? undefined : recommendedTrace(data.traces, data.activeScenario);
  const chip = (key: string) => query.get(key) ? `<button type="button" class="chip-remove" data-clear-filter="${key}" aria-label="Remove ${key} filter">×</button>` : '';
  const select = (key:string,label:string,options:string[][])=>`<details class="filter-popover${query.get(key)?' is-selected':''}"><summary>${label}${query.get(key)?` · ${esc(options.find(([v])=>v===query.get(key))?.[1] ?? query.get(key))}`:''}${chip(key)}<span class="filter-caret" aria-hidden="true">⌄</span></summary><div class="filter-editor" popover="manual"><label>${label}<select name="${key}" aria-label="${label}"><option value="">All</option>${options.map(([v,l])=>`<option value="${esc(v)}" ${query.get(key)===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label><button type="submit">Apply filters</button></div></details>`;
  const rows = data.traces.map(t=>{
    const when = ingested(t.ingestedAt);
    const facts = traceGuideFacts(t);
    const found = facts.detections;
    const isActive = s.story !== null && t.scenario === data.activeScenario;
    const active = isActive ? ' is-active-fixture' : '';
    const descriptionId = `trace-description-${t.id}`;
    const start = recommended?.id === t.id;
    return `<tr class="${active.trim()}" data-trace="${esc(t.id)}"><td><input type="checkbox" aria-label="Select ${esc(t.label)}" data-select></td><td><a data-nav href="${esc(start ? guidedTraceLink(t) : traceLink(t))}" class="trace-row-link${start ? ' trace-start-link' : ''}" ${start ? 'data-guide-target' : ''} aria-describedby="${esc(descriptionId)}"><span class="trace-row-label">${esc(t.label)}</span><small class="trace-row-description" id="${esc(descriptionId)}">${facts.steps} ${facts.steps === 1 ? 'step' : 'steps'} · ${facts.stepErrors} ${facts.stepErrors === 1 ? 'step error' : 'step errors'}</small><span class="trace-row-time">${esc(when.time)} · ${esc(when.date)}</span></a></td><td><span class="ready" title="Ready means processed; task outcome is separate">${icon('check')}<span class="sr">Ready</span></span></td><td>${found?`<span class="failure">Execution Failed &nbsp; ${found}</span>`:'–'}</td><td>—</td><td>${link(traceLink(t),`${esc(t.label)} · ${esc(s.story?.domain ?? 'sample workflow')}${isActive?'<span class="active-tag">Active</span>':s.story===null?'<span class="active-tag">Sample</span>':''}`)}</td><td>${link(traceLink(t),esc(facts.outputSummary))}</td><td>—</td><td><button data-unavailable aria-label="Replay is outside this demo">${icon('clock')}</button></td></tr>`;
  }).join('');
  const days = ['Sep 28','','Sep 30','','Oct 2','','','Oct 5','','Oct 7','','Oct 9','','Oct 11'];
  root.innerHTML = shell(s,`<header class="list-header"><h1>${icon('list')}Traces</h1><div class="header-controls"><div class="trace-view-by"><span>View by</span><button type="button" class="active" aria-pressed="true">Traces</button><button type="button" data-unavailable>Sessions</button><button type="button" data-unavailable>Users</button></div><details class="search-popover" ${query.get('q')?'open':''}><summary aria-label="Search traces">${icon('search')}</summary><form id="search-form"><input name="q" aria-label="Search traces" placeholder="Search traces…" value="${esc(query.get('q') ?? '')}"></form></details><button type="button" data-fixed-date-range class="trace-date-range" title="Fixed demo date range" aria-label="Last 14 days — fixed demo date range">${icon('calendar')}<span>Last 14 days</span>${icon('chevron')}</button><button data-refresh aria-label="Refresh traces">${icon('refresh')}</button></div></header><form id="filters" class="filters"><div class="filter-scroll">${['Session ID','User ID'].map(n=>`<button type="button" data-unavailable class="filter">${n}<span class="filter-caret" aria-hidden="true">⌄</span></button>`).join('')}${select('scenario','Scenario',s.dataset.traces.map(t=>[t.scenario,t.label]))}${select('detection','Detections',[['yes','Execution Failed'],['no','No detections']])}<button type="button" data-unavailable class="filter">Evals<span class="filter-caret" aria-hidden="true">⌄</span></button>${select('tag','Tags',[...new Set(s.dataset.traces.flatMap(t=>t.tags))].map(x=>[x,x]))}<details class="filter-popover${query.get('minMs')?' is-selected':''}"><summary>Latency${query.get('minMs')?` ≥ ${esc(query.get('minMs'))}ms`:''}${chip('minMs')}<span class="filter-caret" aria-hidden="true">⌄</span></summary><div class="filter-editor" popover="manual"><label>Minimum latency in milliseconds<input name="minMs" type="number" min="0" step="0.1" aria-label="Minimum latency in milliseconds" value="${esc(query.get('minMs') ?? '')}" placeholder="ms"></label><button type="submit">Apply filters</button></div></details><button type="button" data-unavailable class="filter">Metadata<span class="filter-caret" aria-hidden="true">⌄</span></button><button type="button" data-unavailable class="filter">More filters<span class="filter-caret" aria-hidden="true">⌄</span></button><button type="button" data-unavailable class="filter">＋ Advanced</button>${link(base(s.id),'Clear')}</div></form><div class="histogram" aria-label="${data.filtered} filtered traces on Oct 10">${days.map((label,i)=>{const count=i===12?data.filtered:0;return `<div class="day" style="--count:${count}" title="${count} traces">${count?`<i class="day-bar" style="--count:${count}"></i>`:''}<span>${label}</span></div>`;}).join('')}</div><div class="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select all traces" id="select-all"></th>${['Ingested at','Status','Detections','Evals','Input','Output','Comments','Replay'].map(traceFieldHeader).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty"><div class="empty-mark">${icon('doc')}</div><h2>No traces found</h2><p>Try adjusting your filters. The demo date range is fixed.</p>${link(base(s.id),'Clear filters','empty-clear')}</td></tr>`}</tbody></table></div>${notice(s)}<footer class="pagination"><label>Rows per page <select aria-label="Rows per page"><option>25</option></select></label><span data-count>${data.filtered?`1 – ${data.filtered}`:'0'} of ${data.filtered}</span><button disabled aria-label="Previous page">‹</button><button class="active">1</button><button disabled aria-label="Next page">›</button></footer>`);
  root.querySelector<HTMLElement>('.workspace')?.classList.add('trace-workspace');
  restoreGuidanceHighlight();
}
function spanRow(t:Trace,s:Span,selected:string|null):string {
  const open = expanded.has(s.id) || s.id===selected;
  const detection = s.detection ? (graph ? '<span class="span-detection is-dot" aria-label="Execution Failed"></span>' : '<span class="span-detection failure">Execution Failed</span>') : '';
  return `<div class="span-row ${s.parentId?'child':''} ${s.id===selected?'selected-span':''}" data-span-id="${s.id}" style="--depth:${s.parentId?1:0}"><button class="span-head" ${s.parentId?'data-expand':'data-root'}="${s.id}" aria-expanded="${s.parentId?open:!collapsedRoots.has(s.id)}">${icon((s.parentId?open:!collapsedRoots.has(s.id))?'minus':'plus')}${icon(s.status==='ERROR'?'close':s.kind==='TOOL'?'tool':'tree')}<span>${esc(s.name)}</span><small>${s.kind}</small>${s.status==='ERROR'?'<b class="error-text">ERROR</b>':''}<time>${durationLabel(s.durationMs)}</time></button>${detection}${open?`<div class="span-content"><div class="span-actions">${link(`${traceLink(t)}?span=${s.id}`,'Link to span')}<button data-copy="${s.id}">Copy span JSON</button></div><label>INPUT</label><pre>${esc(JSON.stringify(s.input,null,2))}</pre>${s.error?`<label class="error-text">ERROR</label><pre class="error-box">${esc(s.error)}</pre>`:`<label>OUTPUT</label><pre>${esc(JSON.stringify(s.output,null,2))}</pre>`}<details class="span-attributes"><summary>Attributes · timing and IDs</summary><dl><dt>Start offset</dt><dd>${s.startMs} ms</dd><dt>Duration</dt><dd>${durationLabel(s.durationMs)}</dd><dt>Span ID</dt><dd>${s.id}</dd><dt>Parent ID</dt><dd>${s.parentId ?? 'Root'}</dd></dl></details></div>`:''}</div>`;
}
function detail(s:DemoSession,t:Trace) {
  if(awaitingPersonalisedDemo(s)){preparationWorkspace(s);return;}
  const selected = new URLSearchParams(location.search).get('span');
  if (selected && !t.spans.some(x=>x.id===selected)) throw new Error('NOT_FOUND: Span not found in this trace.');
  const path = traceLink(t);
  const back = returnTo.startsWith(base(s.id)) && !returnTo.slice(base(s.id).length).startsWith('/') ? returnTo : base(s.id);
  const graphNode = (x: Span) => `<a href="${path}?span=${x.id}" data-graph-select="${x.id}" class="${kindClass(x.kind)} ${graphSelection===x.id?'graph-selected':''}">${icon(kindMark(x.kind))}${x.status==='ERROR'?`<span class="error-x">${icon('close')}</span>`:''}${esc(x.name)}</a>`;
  root.innerHTML=shell(s,`<header class="detail-header">${link(back,icon('back'),'back-link')}<span>${esc(ingested(t.ingestedAt).heading)}</span><div><button data-unavailable aria-label="Search this trace">${icon('search')}</button><button data-unavailable aria-label="Replay unavailable">${icon('clock')}</button><button data-unavailable aria-label="Comments unavailable">${icon('message')}</button><button data-tags>${t.tags.length} tags</button><button data-unavailable>Ask neat AI</button></div></header><div class="trace-toolbar"><details class="trace-picker"><summary aria-label="Trace navigator">${icon('list')}<span>${esc(t.name)}</span><small>${t.spans.length}</small>${icon('chevron')}</summary><nav aria-label="Synthetic trace choices">${s.dataset.traces.map(x=>link(traceLink(x),`${esc(x.label)} · ${x.spans[0]!.durationMs}ms · ${x.spans.length} spans`,x.id===t.id?'active':'')).join('')}</nav></details><button data-graph aria-pressed="${graph}" aria-label="Toggle span tree">${icon('tree')}</button><button data-timeline aria-pressed="${timeline}" aria-label="Toggle timeline">${icon('list')}</button><span class="trace-identity">${esc(t.name)} · ${t.spans.length} spans</span></div><main class="trace-canvas ${timeline?'with-timeline':''}">${graph?`<div class="graph-tree" aria-label="Span parent tree"><div class="graph-nodes"><svg class="graph-connectors" viewBox="0 0 360 360" preserveAspectRatio="none" aria-hidden="true">${t.spans.slice(1).map((_,i)=>`<path d="M140 32 C175 32 175 ${32+i*64} 205 ${32+i*64}"/>`).join('')}</svg><strong class="${kindClass(t.spans[0]!.kind)}">${icon(kindMark(t.spans[0]!.kind))}${esc(t.spans[0]!.name)}</strong><div class="graph-children">${t.spans.slice(1).map(graphNode).join('')}</div></div></div>`:''}<section class="trace-flow"><div class="root-input"><label>INPUT</label><div class="input-bubble">${io(t.input)}</div></div><div class="steps"><header><span>${t.spans.length} STEPS · ${t.spans[0]!.durationMs/1000}S</span><button data-expand-all>EXPAND ALL</button></header>${t.spans.filter(x=>!x.parentId||!collapsedRoots.has(x.parentId)).map(x=>spanRow(t,x,selected)).join('')}</div><div class="root-output"><label>OUTPUT</label><p>${io(t.output)}</p></div></section></main>${timeline?`<section class="timeline" aria-label="Trace timeline"><header>TIMELINE · ${t.spans[0]!.durationMs} ms</header>${t.spans.map(x=>`<div class="timeline-row ${graphSelection===x.id?'graph-selected':''}"><a data-nav href="${path}?span=${x.id}">${esc(x.name)}</a><div class="time-track"><a data-nav aria-label="Select ${esc(x.name)} in timeline" href="${path}?span=${x.id}" class="time-bar ${x.status==='ERROR'?'bad':''}" style="left:${x.startMs/t.spans[0]!.durationMs*100}%;width:${Math.max(0.5,x.durationMs/t.spans[0]!.durationMs*100)}%"></a></div><time>${durationLabel(x.durationMs)}</time></div>`).join('')}</section>`:''}${notice(s)}`);
  restoreGuidanceHighlight();
}
function evalInput(q: EvaluationQuestion, traceId: string) {
  const name = `response:${traceId}:${q.key}`, required = q.required ? 'required' : '';
  if (q.type === 'rating') return `<input type="number" name="${esc(name)}" min="${q.min ?? 1}" max="${q.max ?? 5}" step="1" ${required} aria-label="${esc(q.label)} for ${esc(traceId)}">`;
  if (q.type === 'yes_no') return `<select name="${esc(name)}" ${required} aria-label="${esc(q.label)} for ${esc(traceId)}"><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>`;
  if (q.type === 'choice') return `<select name="${esc(name)}" ${required} aria-label="${esc(q.label)} for ${esc(traceId)}"><option value="">Choose…</option>${(q.options ?? []).map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select>`;
  return `<textarea name="${esc(name)}" maxlength="600" ${required} aria-label="${esc(q.label)} for ${esc(traceId)}"></textarea>`;
}
function evalQuestionRow(q: EvaluationQuestion, index: number) {
  return `<div class="eval-question-config" data-question-row data-question-index="${index}"><label>Question<input name="q-label:${index}" maxlength="120" required value="${esc(q.label)}"></label><label>Answer type<select name="q-type:${index}" data-q-type><option value="rating" ${q.type==='rating'?'selected':''}>Rating</option><option value="yes_no" ${q.type==='yes_no'?'selected':''}>Yes / no</option><option value="choice" ${q.type==='choice'?'selected':''}>Choice</option><option value="text" ${q.type==='text'?'selected':''}>Free text</option></select></label><label data-q-options ${q.type==='choice'?'':'hidden'}>Choice options<input name="q-options:${index}" maxlength="200" value="${esc(q.options?.join(', ') ?? '')}" placeholder="Two or more comma-separated choices"></label><label>Reviewer<select name="reviewer:${index}" aria-label="Reviewer for question ${index+1}"><option value="buyer" ${q.reviewer==='buyer'?'selected':''}>You</option><option value="simulated_judge" ${q.reviewer==='simulated_judge'?'selected':''}>Simulated reviewer</option></select></label><label class="eval-required"><input type="checkbox" name="required:${index}" ${q.required?'checked':''}> Required</label>${q.type==='rating'?`<input type="hidden" name="q-min:${index}" value="${q.min??1}"><input type="hidden" name="q-max:${index}" value="${q.max??5}">`:''}<button type="button" data-remove-question aria-label="Remove question ${index+1}">Remove</button></div>`;
}
function evaluationCheckTable(e: EvaluationDetail['evaluation']): string {
  if(!e.checkResults?.length)return '<p>No deterministic checks were selected. Review responses below are human or illustrative simulated values.</p>';
  return `<h2>Executed sample checks</h2><p>Executed locally against saved synthetic trace snapshot v${e.datasetVersion}. A pass proves only the listed rule; it does not prove answer quality.</p><table><thead><tr><th>Trace</th><th>Check</th><th>Result</th><th>Observed evidence</th></tr></thead><tbody>${e.checkResults.map(r=>`<tr><td>${esc(e.traceSnapshot.find(t=>t.id===r.traceId)?.label??r.traceId)}</td><td>${esc(e.checks?.find(c=>c.key===r.checkKey)?.label??r.checkKey)}</td><td>${r.status==='unavailable'?'Unavailable':r.passed?'Pass':'Fail'}</td><td>${esc(r.explanation)}<small>${esc(JSON.stringify(r.observed))}</small></td></tr>`).join('')}</tbody></table>`;
}
function evalHeader(title: string) { return `<h1>${esc(title)}</h1>`; }
function evaluationsPage(s: DemoSession, data: EvaluationList) {
  evaluations=data; evaluation=undefined;
  const rows=data.evaluations.map(({evaluation:e,stale})=>`<tr><td>${link(evalLink(s.id,e.id),esc(e.name))}${stale?'<small>Saved trace snapshot</small>':''}</td><td>${e.traceIds.length} traces</td><td>${e.questions.map(q=>q.reviewer==='buyer'?'Your review':'Simulated score').filter((x,i,a)=>a.indexOf(x)===i).join(' · ')}</td><td>${e.state==='completed'?'Complete':'In progress'} · ${e.responses.length} saved answers</td></tr>`).join('');
  const defaults=syntheticReviewQuestions();
  root.innerHTML=shell(s,`<main class="eval-page"><header class="list-header"><h1>${icon('check')}Evals</h1><span class="eval-local-label">Docs-grounded reconstruction · synthetic · local demo</span></header><p class="eval-provenance">Synthetic evaluation · local demo · no AI evaluator ran</p><section class="eval-create"><h2>New evaluation</h2><p>Start with the outcome your agent must achieve. Select saved traces, add one question per requirement, and include good, failing and ambiguous examples. A trace without errors can still give a poor answer.</p><form id="create-eval-form"><label>Name<input name="name" maxlength="100" required value="Workflow review"></label><label>Description<input name="description" maxlength="300" placeholder="Optional"></label><fieldset><legend>Saved traces</legend>${s.dataset.traces.map((t,i)=>`<label><input type="checkbox" name="traceId" value="${esc(t.id)}" ${i===0?'checked':''}> ${esc(t.label)}</label>`).join('')}</fieldset><fieldset id="eval-question-editor"><legend>Questions</legend>${defaults.map(evalQuestionRow).join('')}<button type="button" data-add-question>Add question</button></fieldset><fieldset><legend>Deterministic sample checks</legend><label><input type="checkbox" name="check-no-error"> No execution errors</label><label><input type="checkbox" name="check-latency"> Maximum request duration (ms)<input type="number" name="check-max-ms" min="0" max="600000" value="1000"></label><label><input type="checkbox" name="check-fields"> Required output fields<input name="check-fields-list" maxlength="200" placeholder="e.g. answer, citations"></label><small>These checks execute on the saved synthetic snapshot. They do not judge truth, tone or task resolution. Use human review for those requirements.</small></fieldset><button type="submit" ${evalBusy?'disabled':''}>Create evaluation</button><small>Assign each question to you or a simulated reviewer. Simulated review is deterministic demo data; no AI evaluator runs.</small></form></section><section class="eval-list"><h2>Saved evaluations</h2><table><thead><tr><th>Name</th><th>Trace set</th><th>Reviewers</th><th>Status</th></tr></thead><tbody>${rows||'<tr><td colspan="4">No evaluations yet.</td></tr>'}</tbody></table></section></main>${notice(s)}`);
}
function evaluationPage(s: DemoSession, result: EvaluationDetail) {
  evaluation=result; evaluations=undefined;
  const e=result.evaluation;
  const tabs=(['Overview','Questions','Results'] as const).map(t=>`<button type="button" data-eval-tab="${t}" aria-pressed="${evaluationTab===t}">${t}</button>`).join('');
  let panel='';
  if(evaluationTab==='Overview') panel=`<section class="eval-overview"><dl><div><dt>State</dt><dd>${e.state==='completed'?'Complete':'In progress'}</dd></div><div><dt>Source</dt><dd>Synthetic · local demo</dd></div><div><dt>Version</dt><dd>v${e.version} · traces v${e.datasetVersion}</dd></div></dl><h2>Questions</h2><ul>${e.questions.map(q=>`<li>${esc(q.label)} · ${q.reviewer==='buyer'?'Your review':'Simulated score — no AI evaluator ran'}</li>`).join('')}</ul><h2>Saved traces</h2><ul>${e.traceSnapshot.map(t=>`<li>${link(traceLink(t),esc(t.label))} · ${esc(t.outcomeKind)}</li>`).join('')}</ul></section>`;
  if(evaluationTab==='Questions') {
    const qs=e.questions.filter(q=>q.reviewer==='buyer'),sims=e.questions.filter(q=>q.reviewer==='simulated_judge');
    const simRows=e.responses.filter(r=>r.source==='simulated_judge').map(r=>{const q=e.questions.find(x=>x.key===r.questionKey),t=e.traceSnapshot.find(x=>x.id===r.traceId);return `<tr><td>${esc(t?.label??r.traceId)}</td><td>${esc(q?.label??r.questionKey)}</td><td>${esc(String(r.value))}</td><td>Simulated score — no AI evaluator ran</td></tr>`}).join('');
    panel=`<section class="eval-questions"><h2>Your review</h2><form id="review-eval-form">${qs.length?e.traceSnapshot.map(t=>`<fieldset><legend>${esc(t.label)}</legend>${qs.map(q=>`<label class="eval-answer"><span>${esc(q.label)}</span>${evalInput(q,t.id)}</label>`).join('')}</fieldset>`).join(''):'<p>No questions are assigned to you.</p>'}${sims.length?`<div class="eval-simulation-note"><strong>Simulated reviewer · no AI evaluator ran</strong><table><thead><tr><th>Trace</th><th>Question</th><th>Saved value</th><th>Source</th></tr></thead><tbody>${simRows||`<tr><td colspan="4">${sims.length} simulated question${sims.length===1?'':'s'}; no saved score yet.</td></tr>`}</tbody></table></div>`:''}<button type="submit" ${evalBusy||!qs.length?'disabled':''}>Save review</button></form></section>`;
  }
  if(evaluationTab==='Results') {
    const aggs=e.aggregates.map(a=>{const q=e.questions.find(x=>x.key===a.questionKey);const val=a.value!==null?(q?.type==='yes_no'?`${Math.round(a.value*100)}% yes`:String(a.value)):a.answeredCount>0?(q?.type==='text'?`${a.answeredCount} text response${a.answeredCount===1?'':'s'} · no numeric score`:`${a.answeredCount} response${a.answeredCount===1?'':'s'} saved · no numeric score`):'No saved responses';return `<tr><td>${esc(q?.label??a.questionKey)}</td><td>${a.answeredCount} / ${a.totalCount}</td><td>${esc(val)}</td><td>${a.source==='simulated_judge'?'Simulated score — no AI evaluator ran':a.source==='buyer'?'Your review':'Mixed sources'}</td></tr>`}).join('');
    const responses=e.responses.map(r=>{const q=e.questions.find(x=>x.key===r.questionKey),t=e.traceSnapshot.find(x=>x.id===r.traceId);return `<tr><td>${t?link(traceLink(t),esc(t.label)):esc(r.traceId)}</td><td>${esc(q?.label??r.questionKey)}</td><td>${esc(String(r.value))}</td><td>${r.source==='simulated_judge'?'Simulated score — no AI evaluator ran':'Your review'}</td></tr>`}).join('');
    panel=`<section class="eval-results">${evaluationCheckTable(e)}<h2>Per-question summary</h2><table><thead><tr><th>Question</th><th>Answered</th><th>Result</th><th>Source</th></tr></thead><tbody>${aggs||'<tr><td colspan="4">No saved responses yet.</td></tr>'}</tbody></table><h2>Saved responses</h2><table><thead><tr><th>Trace</th><th>Question</th><th>Response</th><th>Source</th></tr></thead><tbody>${responses||'<tr><td colspan="4">No saved responses yet.</td></tr>'}</tbody></table></section>`;
  }
  root.innerHTML=shell(s,`<main class="eval-page"><header class="eval-detail-header">${link(evalBase(s.id),'← Evals')}<div>${evalHeader(e.name)}<p>${esc(e.description||'Review of saved synthetic traces')}</p></div><span class="eval-local-label">Docs-grounded reconstruction</span></header><p class="eval-provenance">Synthetic evaluation · local demo · no AI evaluator ran</p>${result.stale?'<p role="status" class="eval-stale">Saved trace snapshot · the current dataset has changed.</p>':''}<nav class="eval-tabs" aria-label="Evaluation detail">${tabs}</nav>${panel}</main>${notice(s)}`);
}
async function createEvaluation(form: HTMLFormElement) {
  if(!current||evalBusy)return;
  const f=new FormData(form), traceIds=f.getAll('traceId').map(String);
  if(!traceIds.length){toast('Choose at least one saved trace.');return;}
  evalBusy=true;
  const rows=[...form.querySelectorAll<HTMLElement>('[data-question-row]')];
  if(rows.length<1||rows.length>8){evalBusy=false;toast('Choose between one and eight questions.');return;}
  if(rows.some(row=>String(f.get(`q-type:${row.dataset.questionIndex}`))==='choice'&&String(f.get(`q-options:${row.dataset.questionIndex}`)??'').split(',').map(x=>x.trim()).filter(Boolean).length<2)){evalBusy=false;toast('Add at least two choices for each choice question.');return;}
  const questions:EvaluationQuestion[]=rows.map(row=>{
    const index=Number(row.dataset.questionIndex);
    const label=String(f.get(`q-label:${index}`)??'').trim(),key=(label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,34)||`question-${index+1}`);
    const type=String(f.get(`q-type:${index}`)) as EvaluationQuestion['type'];
    const q:EvaluationQuestion={key:`${key}-${index+1}`,label,type,required:f.has(`required:${index}`),reviewer:String(f.get(`reviewer:${index}`)) as EvaluationQuestion['reviewer']};
    if(type==='rating'){q.min=Number(f.get(`q-min:${index}`)??1);q.max=Number(f.get(`q-max:${index}`)??5);}
    if(type==='choice')q.options=String(f.get(`q-options:${index}`)??'').split(',').map(x=>x.trim()).filter(Boolean);
    return q;
  });
  const checks:EvaluationCheck[]=[];
  if(f.has('check-no-error'))checks.push({key:'no-error',label:'No execution errors',kind:'no_error'});
  if(f.has('check-latency'))checks.push({key:'latency',label:'Request duration limit',kind:'latency',maxDurationMs:Number(f.get('check-max-ms'))});
  if(f.has('check-fields'))checks.push({key:'required-fields',label:'Required output fields',kind:'required_output_fields',fields:String(f.get('check-fields-list')??'').split(',').map(x=>x.trim()).filter(Boolean)});
  try { const result=await request<EvaluationDetail>(`/api/sessions/${current.id}/evaluations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientOperationId:crypto.randomUUID(),datasetVersion:current.version,name:String(f.get('name')??''),description:String(f.get('description')??''),traceIds,questions,checks})},true); evaluationTab='Overview'; await navigate(evalLink(current.id,result.evaluation.id)); }
  catch(e){toast(plain((e as Error).message));} finally{evalBusy=false;}
}
async function saveEvaluationReview(form: HTMLFormElement) {
  if(!current||!evaluation||evalBusy)return;
  const e=evaluation.evaluation,f=new FormData(form),responses:ReviewEvaluationRequest['responses']=[];
  for(const t of e.traceSnapshot)for(const q of e.questions.filter(x=>x.reviewer==='buyer')){const v=f.get(`response:${t.id}:${q.key}`);if(v===null||String(v).trim()==='')continue;responses.push({traceId:t.id,questionKey:q.key,value:q.type==='rating'?Number(v):q.type==='yes_no'?String(v)==='true':String(v)});}
  evalBusy=true;
  try{evaluation=await request<EvaluationDetail>(`/api/sessions/${current.id}/evaluations/${e.id}/reviews`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientOperationId:crypto.randomUUID(),datasetVersion:e.datasetVersion,expectedVersion:e.version,responses})},true);evaluationTab='Results';sessionStorage.setItem(evaluationTabKey(e.id),evaluationTab);evaluationPage(current,evaluation);}
  catch(error){toast(plain((error as Error).message));}finally{evalBusy=false;}
}
function routingDraft(s:DemoSession):Record<string,string|string[]> {
  let draft=routingDrafts.get(s.id);
  if(!draft){draft={name:'Synthetic signal review',type:'per_event',threshold:'1',severity:'warning',cooldown:'60000',recipient:'Engineering on-call',destination:'in_app',traceIds:s.dataset.traces.map(t=>t.id)};routingDrafts.set(s.id,draft);}
  return draft;
}
function routingPage(s:DemoSession){
  const d=routingDraft(s),steps=['Type','Condition','Details','Response','Confirm'];
  const selected=(key:string,value:string)=>d[key]===value?'selected':'';
  let panel='';
  if(routingDetail){const p=routingDetail.preview;panel=`<section class="routing-create"><h2>${esc(p.name)}</h2><p role="status">${p.conditionMet?'Simulated delivery preview · no notification sent':'Condition not met · no notification sent'}</p>${routingDetail.stale?'<p class="eval-stale">Saved trace snapshot · current traces changed.</p>':''}<dl><dt>Fictional owner</dt><dd>${esc(p.recipient)}</dd><dt>Destination</dt><dd>${esc(p.destination)}</dd><dt>Severity / cooldown</dt><dd>${esc(p.severity)} / ${p.cooldownMs} ms</dd><dt>Source</dt><dd>Deterministic match against saved synthetic trace snapshot v${p.datasetVersion}</dd></dl><h3>Action context</h3>${p.matches.length?p.matches.map(m=>`<article><strong>${esc(p.traceSnapshot.find(t=>t.id===m.traceId)?.label??m.traceId)}</strong><p>${esc(m.context)}</p><small>${m.spanIds.length} matching saved spans · ${esc(m.owner)}</small></article>`).join(''):'<p>No matching saved signals.</p>'}${link(routingBase(s.id),'← Alerts')}</section>`;}
  else{
    if(routingStep===0)panel=`<h2>What should trigger this alert?</h2><label>Type<select name="type"><option value="per_event" ${selected('type','per_event')}>Per event</option><option value="threshold" ${selected('type','threshold')}>Threshold</option></select></label><p>This preview supports saved execution errors. Metric threshold, compound and ingestion health rules are documented product features; they are outside this local preview.</p>`;
    if(routingStep===1)panel=`<h2>Which signals should we match?</h2><fieldset><legend>Saved synthetic traces</legend>${s.dataset.traces.map(t=>`<label><input type="checkbox" name="traceId" value="${esc(t.id)}" ${(d.traceIds as string[]).includes(t.id)?'checked':''}> ${esc(t.label)}</label>`).join('')}</fieldset>${d.type==='threshold'?`<p>Counts only failure outcomes; recovered and escalation outcomes do not count.</p><label>Failed trace threshold<input type="number" name="threshold" min="1" max="4" value="${esc(d.threshold)}"></label>`:'<p>Match each trace containing an ERROR span. Successful retries can still contain an error signal.</p>'}`;
    if(routingStep===2)panel=`<h2>Add details</h2><label>Name<input name="name" maxlength="120" value="${esc(d.name)}" required></label><label>Severity<select name="severity"><option value="warning" ${selected('severity','warning')}>Warning</option><option value="critical" ${selected('severity','critical')}>Critical</option></select></label><label>Cooldown (ms)<input name="cooldown" type="number" min="0" max="600000" value="${esc(d.cooldown)}"></label><p>Cooldown is recorded for discussion. This one-shot preview does not schedule or throttle future deliveries.</p>`;
    if(routingStep===3)panel=`<h2>How should we tell you?</h2><p>Choose where this alert would be delivered. All destinations below are simulated; no integration is connected.</p><label>Fictional owner<select name="recipient">${['Engineering on-call','Quality reviewer','Product owner'].map(x=>`<option ${selected('recipient',x)}>${x}</option>`).join('')}</select></label><label>Destination<select name="destination"><option value="in_app" ${selected('destination','in_app')}>In-app (simulated)</option><option value="email" ${selected('destination','email')}>Email (simulated)</option><option value="slack" ${selected('destination','slack')}>Slack (simulated)</option></select></label><p>In Neatlogs, email preferences and connected Slack destinations affect delivery. This demo never asks for a real address or contact.</p>`;
    if(routingStep===4)panel=`<h2>Confirm synthetic preview</h2><p>${esc(d.name)} · ${esc(d.type)} · ${esc(d.severity)}</p><p>${(d.traceIds as string[]).length} saved traces → ${esc(d.recipient)} via ${esc(d.destination)}.</p><p>Evaluate the condition locally, save its evidence and preview the action context. No real alert rule or message will be created.</p>`;
    panel=`<section class="eval-create routing-create"><nav class="eval-tabs" aria-label="Alert preview steps">${steps.map((x,i)=>`<span ${i===routingStep?'aria-current="step"':''}>${i+1}. ${x}</span>`).join('')}</nav><form id="routing-form">${panel}<div>${routingStep?'<button type="button" data-routing-back>Back</button>':''}<button type="submit" ${routingBusy?'disabled':''}>${routingStep===4?'Save simulated preview':'Next'}</button></div></form></section><section class="eval-list"><h2>Saved previews</h2>${routingList?.previews.map(r=>link(`${routingBase(s.id)}/${r.preview.id}`,esc(r.preview.name))).join('<br>')||'<p>No previews yet.</p>'}</section>`;
  }
  root.innerHTML=shell(s,`<main class="eval-page"><header class="list-header"><h1>${icon('bell')}alerts</h1><span class="eval-local-label">Synthetic routing preview</span></header><p class="eval-provenance">Local demo · no real contact, alert rule or outbound message</p>${panel}</main>${notice(s)}`);
}
function saveRoutingDraft(form:HTMLFormElement){if(!current)return;const d=routingDraft(current),f=new FormData(form);for(const key of ['name','type','threshold','severity','cooldown','recipient','destination'])if(f.has(key))d[key]=String(f.get(key));if(routingStep===1)d.traceIds=f.getAll('traceId').map(String);}
async function submitRouting(form:HTMLFormElement){
  if(!current||routingBusy)return;saveRoutingDraft(form);const s=current,d=routingDraft(s);
  if(routingStep===1&&!(d.traceIds as string[]).length){toast('Select at least one saved trace.');return;}
  if(routingStep<4){routingStep++;routingPage(s);return;}
  routingBusy=true;
  try{const result=await request<RoutingDetail>(`/api/sessions/${s.id}/routing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientOperationId:crypto.randomUUID(),datasetVersion:s.version,name:d.name,traceIds:d.traceIds,rule:d.type==='per_event'?{type:'per_event'}:{type:'threshold',failedTraceThreshold:Number(d.threshold)},recipient:d.recipient,destination:d.destination,severity:d.severity,cooldownMs:Number(d.cooldown)})},true);await navigate(`${routingBase(s.id)}/${result.preview.id}`);}catch(error){toast(plain((error as Error).message));}finally{routingBusy=false;}
}
async function render(preserveEntry = false): Promise<boolean> {
  stopEntryRotation();
  entryViewTransition?.skipTransition();
  entryViewTransition = undefined;
  document.documentElement.classList.remove('entry-view-transition');
  const keepEntry = preserveEntry && !!entryPreparation?.demoId && location.pathname === base(entryPreparation.demoId) && !!root.querySelector('.chat-stage.is-preparing');
  if (entryPreparation && !keepEntry) {
    if (!entryPreparation.demoId) saveDraft(draft.map(t => ({ ...t, status: 'failed' as const })));
    entryPreparation = undefined; chatBusy = false; pendingTurn = undefined;
  }
  const run = ++generation; controller?.abort(); controller = new AbortController(); ended = false;
  void loadExecution();
  if (location.pathname==='/') { landing(); return true; }
  if (location.pathname==='/entry') { void loadBrowserSession(); entry(); return true; }
  document.documentElement.classList.remove('chat-dock');
  if (!keepEntry) root.innerHTML=activeGuidance && current ? shell(current,'<main class="loading" role="status">Loading the relevant area…</main>') : '<main class="loading" role="status">Loading synthetic traces…</main>';
  try {
    const route = /^\/demo\/([^/]+)\/(traces|evals|alerts)(?:\/([^/]+))?$/.exec(location.pathname);
    if (!route) throw new Error('NOT_FOUND: Page not found.');
    const s = await request<DemoSession>(`/api/sessions/${route[1]}`);
    if (run!==generation) return false;
    if (current?.id !== s.id) { pendingTurn=undefined; lastResult=undefined; turnNote=''; chatBusy=false; }
    current=s; chatOpen = sessionStorage.getItem(chatKey(s.id)) !== '1';
    await loadBrowserSession();
    if (run!==generation) return false;
    restorePending(s);
    restoreSteps(s);
    if(awaitingPersonalisedDemo(s) && route[2]==='evals'){preparationWorkspace(s);return run===generation;}
    if(route[2]==='alerts'){
      if(route[3]){routingDetail=await request<RoutingDetail>(`/api/sessions/${s.id}/routing/${route[3]}`);routingList=undefined;}
      else{routingList=await request<RoutingList>(`/api/sessions/${s.id}/routing`);routingDetail=undefined;routingStep=0;}
      routingPage(s);
    } else if (route[2] === 'evals') {
      evaluationTab = route[3] ? (sessionStorage.getItem(evaluationTabKey(route[3])) as typeof evaluationTab | null) ?? 'Overview' : 'Overview';
      if (route[3]) evaluationPage(s, await request<EvaluationDetail>(`/api/sessions/${s.id}/evaluations/${route[3]}`));
      else evaluationsPage(s, await request<EvaluationList>(`/api/sessions/${s.id}/evaluations`));
    } else if (route[3]) {
      const t=s.dataset.traces.find(t=>t.id===route[3]); if (!t) throw new Error('NOT_FOUND: Trace not found in this session.');
      const selected = new URLSearchParams(location.search).get('span');
      if (selected && t.spans.some(span => span.id === selected)) for (const ancestorId of selectedSpanAncestors(t, selected)) collapsedRoots.delete(ancestorId);
      detail(s,t);
    } else {
      const data=await request<TraceList>(`/api/sessions/${s.id}/traces${location.search}`);
      if (run!==generation) return false;
      // Publication racing the two reads: retry against a coherent version.
      if (data.version!==s.version) return render(keepEntry);
      const commit = () => { if (run === generation) { entryPreparation = undefined; list(s,data); } };
      if (keepEntry && typeof document.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.documentElement.classList.add('entry-view-transition');
        try {
          const transition = document.startViewTransition(commit);
          entryViewTransition = transition;
          void transition.finished.catch(() => {}).finally(() => {
            if (entryViewTransition === transition) { entryViewTransition = undefined; document.documentElement.classList.remove('entry-view-transition'); }
          });
          try { await transition.updateCallbackDone; }
          catch { if (run === generation && root.querySelector('.chat-stage.is-preparing')) commit(); }
        } catch {
          document.documentElement.classList.remove('entry-view-transition');
          commit();
        }
      } else commit();
    }
    return run === generation;
  } catch(e) {
    if (run!==generation || (e as Error).name==='AbortError') return false;
    entryPreparation = undefined;
    if (e instanceof ApiFailure && (e.status===404 || e.status===403)) { showUnavailable(); return false; }
    document.documentElement.classList.remove('chat-dock');
    root.innerHTML=`<main class="ended request-error"><h1>Demo unavailable</h1><p role="alert">${esc(plain((e as Error).message))}</p><button data-refresh>Retry</button> ${link('/entry','Create a fictional session')}</main>`;
    return false;
  }
}
type StoredTurn = TurnRequest & { sessionId: string; baseConversationVersion?: number };
/**
 * A request that never got an answer (reload, network drop, server crash) is offered again with the SAME clientTurnId.
 * The server recognises a repeat and replays the original answer or reports honestly (readback_uncertain / provider_unavailable).
 */
function restorePending(s: DemoSession) {
  if (pendingTurn || chatBusy) return;
  try {
    const stored = JSON.parse(sessionStorage.getItem('tailor-pending-turn') ?? 'null') as StoredTurn | null;
    if (!stored || stored.sessionId !== s.id) return;
    const last = s.conversation[s.conversation.length - 1];
    // Answered already: the server's last accepted turn is this one, or the thread grew past the buyer turn we sent.
    const answered = s.lastClientTurnId === stored.clientTurnId
      || (stored.baseConversationVersion === undefined ? last?.role === 'tailor' : s.conversationVersion > stored.baseConversationVersion + 1);
    if (answered) { sessionStorage.removeItem('tailor-pending-turn'); return; }
    const { sessionId: _ignored, baseConversationVersion: _base, ...req } = stored;
    pendingTurn = { turn: stamp('buyer', req.text, 'uncertain'), request: req, why: 'server' };
    turnNote = 'Your last message may not have been delivered. Retrying re-sends the same request; the server recognises it and will not apply it twice.';
  } catch { sessionStorage.removeItem('tailor-pending-turn'); }
}
/** The step strip is kept per session while its turn is still the last one the server accepted; otherwise it is omitted. */
function restoreSteps(s: DemoSession) {
  if (lastResult || chatBusy) return;
  try {
    const stored = JSON.parse(sessionStorage.getItem(stepsKey(s.id)) ?? 'null') as { clientTurnId: string; steps: TurnStep[]; outcome: TurnOutcome } | null;
    if (stored && stored.clientTurnId === s.lastClientTurnId && Array.isArray(stored.steps)) lastResult = { steps: stored.steps, outcome: stored.outcome };
  } catch { sessionStorage.removeItem(stepsKey(s.id)); }
}
function stamp(role: ChatTurn['role'], text: string, status: ChatTurn['status']): ChatTurn {
  return { id: crypto.randomUUID(), role, text, status, at: new Date().toISOString() };
}
function repaint() {
  if (ended) return;
  if (!current || location.pathname === '/entry' || location.pathname === '/') { entry(); return; }
  if(location.pathname.includes('/alerts')){routingPage(current);return;}
  if (location.pathname.includes('/evals')) { if(evaluation)evaluationPage(current,evaluation);else if(evaluations)evaluationsPage(current,evaluations);else void render(); return; }
  if (/\/traces\/[^/]+$/.test(location.pathname)) {
    const trace = current.dataset.traces.find(t => location.pathname.endsWith(`/${t.id}`));
    if (trace) detail(current, trace); else navigate(base(current.id));
    return;
  }
  if (lastList) list(current, { ...lastList, version: current.version, activeScenario: current.dataset.activeScenario });
  else void render();
}
const impliedStatus = (outcome: TurnOutcome): ChatTurn['status'] =>
  outcome === 'committed' ? 'applied'
  : outcome === 'rejected' || outcome === 'save_failed' || outcome === 'conflict' || outcome === 'provider_unavailable' ? 'failed'
  : outcome === 'readback_uncertain' ? 'uncertain' : 'note';
/** Re-read the session (and the trace list when it is on screen) so the page only ever shows what the server holds. */
async function refresh(): Promise<boolean> {
  if (!current) return false;
  const id = current.id;
  try {
    const onList = location.pathname === base(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await request<DemoSession>(`/api/sessions/${id}`, {}, true);
      const listed = onList ? await request<TraceList>(`/api/sessions/${id}/traces${location.search}`, {}, true) : undefined;
      if (current?.id !== id) return false;
      if (listed && listed.version !== fresh.version) continue;
      current = fresh;
      if (listed) lastList = listed;
      return true;
    }
    return false;
  } catch { return false; }
}
function mergeMessages(conversation: ChatTurn[], messages: ChatTurn[]): ChatTurn[] {
  const next = [...conversation];
  for (const message of messages) {
    const at = next.findIndex(t => t.id === message.id);
    if (at >= 0) next[at] = message; else next.push(message);
  }
  return next;
}
async function applyResponse(response: TurnResponse, sessionId: string, viewGeneration: number) {
  const ownsView = () => current?.id === sessionId && generation === viewGeneration && location.pathname.startsWith(`/demo/${sessionId}/`);
  if (!current || !ownsView()) return;
  const echoed = response.messages.some(m => m.role === 'buyer');
  const stillOpen = pendingTurn;
  const reread = response.outcome === 'committed' || response.outcome === 'readback_uncertain' || response.outcome === 'conflict' || response.outcome === 'save_failed';
  if (response.outcome === 'expired') { showEnded(); return; }
  let refreshed = false;
  if (reread) {
    // The thread keeps the buyer turn Pending until the saved version has been read again.
    refreshed = await refresh();
    if (ended) return;
  }
  if (!current || !ownsView()) return;
  let conversation = current.conversation;
  if (!echoed && stillOpen) {
    const at = conversation.findIndex(t => t.role === 'buyer' && t.text === stillOpen.turn.text && (t.status === 'pending' || t.status === 'note'));
    const buyer = { ...stillOpen.turn, status: impliedStatus(response.outcome) };
    if (at >= 0) conversation = conversation.map((t, i) => i === at ? { ...t, status: buyer.status } : t);
    else if (!conversation.some(t => t.id === buyer.id)) conversation = [...conversation, buyer];
  }
  conversation = mergeMessages(conversation, response.messages);
  current = { ...current, conversation, conversationVersion: Math.max(current.conversationVersion, response.conversationVersion), version: refreshed ? current.version : response.version };
  pendingTurn = undefined;
  sessionStorage.removeItem('tailor-pending-turn');
  turnNote = '';
  if (response.outcome === 'readback_uncertain') turnNote = refreshed ? `Not confirmed. I re-read your demo: the version that is actually live is v${current.version}.` : 'Not confirmed. Reload the page to see which version is actually live.';
  else if (reread && !refreshed) turnNote = 'I couldn’t refresh the view just now. Reload the page to see the latest version.';
  else if (response.outcome === 'committed' && current.version < response.version) turnNote = `The view shows v${current.version} but the last save was v${response.version}. Reload if this looks wrong.`;
  chatBusy = false;
  if(current.story!==null)sessionStorage.removeItem(`tailor-entry-awaiting:${current.id}`);
  repaint();
  if(response.outcome==='committed' && refreshed && current.story!==null && current.version===response.version) {
    const key=`tailor-auto-guidance:${current.id}:${response.messages.filter(turn=>turn.role==='tailor').map(turn=>turn.id).join(':')}`;
    if(sessionStorage.getItem(key)!=='1') {
      const answer=[...response.messages].reverse().find(turn=>turn.role==='tailor' && turn.guidance?.some(g=>guidanceCurrent(g,current!)));
      const first=answer?.guidance?.find(g=>guidanceCurrent(g,current!));
      if(answer && first){sessionStorage.setItem(key,'1');await showGuidance(answer.id,first.id);}
    }
  }
}
const RETRY_COPY = 'Retrying re-sends the same request; the server recognises it and will not apply it twice.';
async function runTurn(req: TurnRequest) {
  const s = current;
  if (!s) return;
  const viewGeneration=generation;
  const ownsView = () => current?.id === s.id && generation === viewGeneration && location.pathname.startsWith(`/demo/${s.id}/`);
  const leaveView = () => {
    // Keep the stored request for same-ID recovery when this demo is reopened.
    if (pendingTurn?.request.clientTurnId === req.clientTurnId) { pendingTurn=undefined; chatBusy=false; }
    if (location.pathname === '/entry' && !chatBusy) entry();
  };
  chatBusy = true; turnNote = '';
  if (pendingTurn) pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'pending' } };
  // The base conversation version lets a reload tell "never reached the server" from "answered meanwhile"; it survives retries.
  let baseVersion = s.conversationVersion;
  try { const earlier = JSON.parse(sessionStorage.getItem('tailor-pending-turn') ?? 'null') as StoredTurn | null; if (earlier && earlier.clientTurnId === req.clientTurnId && earlier.baseConversationVersion !== undefined) baseVersion = earlier.baseConversationVersion; } catch { /* ignore */ }
  sessionStorage.setItem('tailor-pending-turn', JSON.stringify({ sessionId: s.id, baseConversationVersion: baseVersion, ...req }));
  repaint();
  let response: TurnResponse;
  try {
    response = await request<TurnResponse>(`/api/sessions/${s.id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }, true);
  } catch (e) {
    if (!ownsView()) { leaveView(); return; }
    chatBusy = false;
    if (isEnded(e) || ended) return;
    if (e instanceof ApiFailure && e.code === 'TURN_IN_FLIGHT') {
      pendingTurn = undefined; sessionStorage.removeItem('tailor-pending-turn'); restoreText = req.text;
      turnNote = 'Still working on your last message. Try again in a moment.';
    } else if (e instanceof ApiFailure && e.status >= 500) {
      // The server failed while handling the request; whether it was applied is unknown. Say so, re-read, keep it retryable.
      if (pendingTurn) pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'uncertain' }, why: 'server' };
      const refreshed = await refresh();
      turnNote = `Tailor hit a server error and can’t confirm whether your message was applied.${refreshed && current ? ` The demo currently shows version ${current.version}.` : ''} ${RETRY_COPY}`;
    } else if (e instanceof ApiFailure) {
      // A 4xx answer means the server refused the request before acting on it.
      if (pendingTurn) pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'failed' } };
      sessionStorage.removeItem('tailor-pending-turn');
      turnNote = e.code === 'TRACE_NOT_FOUND' ? 'The trace you have open is no longer part of this demo, so I couldn’t use it. Nothing was changed.' : `${plain(e.message)} Nothing was changed.`;
    } else {
      // No response at all: keep the request so a retry reuses the same clientTurnId (the server dedupes it).
      if (pendingTurn) pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'failed' }, why: 'unsent' };
      turnNote = `Tailor could not reach the server; your message was not sent. ${RETRY_COPY}`;
    }
    repaint();
    return;
  }
  if (!ownsView()) { leaveView(); return; }
  if (ended) return;
  // The mode label comes only from /api/execution. A turn envelope that disagrees never relabels the UI: show
  // "Provider status unavailable" and ask /api/execution again.
  if (!sameExecution(execution, response.execution)) { execution = undefined; paintExecution(); void loadExecution(); }
  lastResult = { steps: response.steps, outcome: response.outcome };
  try { sessionStorage.setItem(stepsKey(s.id), JSON.stringify({ clientTurnId: req.clientTurnId, steps: response.steps, outcome: response.outcome })); } catch { /* quota: the strip is optional */ }
  await applyResponse(response,s.id,viewGeneration);
  if (!ownsView()) { leaveView(); return; }
  if (!ended && response.demoId && current && response.demoId !== current.id) {
    await loadBrowserSession();
    const next = await request<DemoSession>(`/api/sessions/${response.demoId}`, {}, true);
    current = next; lastList = undefined; lastResult = undefined; turnNote = '';
    chatOpen = true;
    sessionStorage.removeItem(chatKey(next.id));
    await navigate(base(next.id));
  }
}
async function sendTurn(text: string, choiceId?: string, confirmationRef?: string) {
  if (!current || chatBusy) return;
  const retryable = pendingTurn && (pendingTurn.turn.status === 'failed' || pendingTurn.turn.status === 'uncertain');
  const kept = retryable && pendingTurn!.request.text === text && pendingTurn!.request.choiceId === choiceId ? pendingTurn!.request : undefined;
  const open = openTrace(current);
  const req: TurnRequest = kept ?? { text, clientTurnId: crypto.randomUUID(), ...(choiceId ? { choiceId } : {}), ...(confirmationRef ? { confirmationRef } : {}), ...(open ? { openTraceId: open.id } : {}) };
  pendingTurn = { turn: stamp('buyer', text, 'pending'), request: req };
  await runTurn(req);
}
async function startSession(text: string) {
  chatBusy = true;
  const preparation: { demoId?: string } = {};
  entryPreparation = preparation;
  const payload = JSON.stringify({ description: text, conversation: [] });
  let operation = sessionStorage.getItem('creation-operation');
  let firstTurnId = sessionStorage.getItem('creation-turn-id');
  if (!operation || !firstTurnId || sessionStorage.getItem('creation-payload') !== payload) {
    operation = crypto.randomUUID(); firstTurnId = crypto.randomUUID();
    sessionStorage.setItem('creation-operation', operation);
    sessionStorage.setItem('creation-turn-id', firstTurnId);
    sessionStorage.setItem('creation-payload', payload);
  }
  saveDraft([stamp('buyer', text, 'pending')]);
  entry();
  let created: DemoSession;
  let createStarted = false;
  try {
    // Establish the owner cookie before the first create so a lost create response can
    // be retried with the same idempotency key and still resolve to the same demo.
    if (!browserSession) browserSession = await request<BrowserSession>('/api/browser-session', { method: 'POST' }, true);
    createStarted = true;
    created = await request<DemoSession>('/api/browser-session/demos', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation }, body: payload }, true);
  } catch (e) {
    if (entryPreparation !== preparation) return;
    entryPreparation = undefined;
    chatBusy = false;
    if (isEnded(e) || ended) return;
    saveDraft(draft.map(t => ({ ...t, status: 'failed' as const })));
    entry();
    const failure = e instanceof ApiFailure ? e : undefined;
    const copy = !failure ? createStarted ? 'Tailor could not reach the server; your message was not sent. Send again to retry.' : 'Tailor could not reach the server to prepare this browser session. No demo was created. Send again to retry.'
      : failure.status >= 500 ? createStarted ? 'Tailor hit a server error and can’t confirm whether your demo was created. Send again; the server recognises the same request and will not create it twice.' : 'Tailor could not prepare this browser session. No demo was created. Send again to retry.'
      : `${plain(failure.message)} Nothing was created. Send again to retry.`;
    document.querySelector('.form-error')?.replaceChildren(document.createTextNode(copy));
    return;
  }
  if (entryPreparation !== preparation) return;
  const req: TurnRequest = { text, clientTurnId: firstTurnId };
  // Make the first turn recoverable before removing creation/draft identity or
  // awaiting optional metadata: reloading at either point must retain this ID.
  sessionStorage.setItem('tailor-pending-turn', JSON.stringify({ sessionId: created.id, baseConversationVersion: created.conversationVersion, ...req }));
  preparation.demoId = created.id;
  sessionStorage.setItem(`tailor-entry-awaiting:${created.id}`,'1');
  const phase = document.querySelector<HTMLElement>('[data-entry-phase]');
  if (phase) phase.textContent = 'Loading your demo…';
  for (const key of ['creation-operation', 'creation-payload', 'creation-turn-id', 'tailor-draft-chat']) sessionStorage.removeItem(key);
  draft = [];
  await loadBrowserSession();
  if (entryPreparation !== preparation) return;
  current = created; lastList = undefined; lastResult = undefined; turnNote = '';
  chatOpen = true; sessionStorage.removeItem(chatKey(created.id));
  pendingTurn = { turn: stamp('buyer', text, 'pending'), request: req };
  chatBusy = true;
  const ready = await navigate(base(created.id), true);
  if (!ready || ended || current?.id !== created.id || location.pathname !== base(created.id)) {
    if (pendingTurn?.request.clientTurnId === req.clientTurnId) {
      chatBusy = false;
      if (location.pathname === base(created.id)) {
        pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'failed' }, why: 'unsent' };
        turnNote = `Your message has not been sent. ${RETRY_COPY}`;
      } else pendingTurn = undefined;
    }
    return;
  }
  await runTurn(req);
}
async function sendChat(text: string, choiceId?: string, confirmationRef?: string) {
  const message = text.trim();
  if (!message || chatBusy) return;
  entryNotice = '';
  if (location.pathname === '/entry' || !current) await startSession(message);
  else await sendTurn(message, choiceId, confirmationRef);
}
async function endDemo() {
  if (!current) return;
  const id = current.id;
  try { await request(`/api/sessions/${id}/end`, { method: 'POST' }, true); }
  catch (e) { if (isEnded(e)) return; toast('Couldn’t end the demo just now. Nothing was deleted; try again.'); return; }
  clearLocalState();
  await loadBrowserSession();
  entryNotice = 'Demo ended. Your conversation and demo data were deleted.';
  navigate('/entry');
}
async function selectDemo(demoId: string) {
  if (!browserSession || !entrySavedState(browserSession).demos.some(d => d.id === demoId)) return;
  if (demoId === current?.id && demoId === browserSession.activeDemoId) {
    if (location.pathname === '/entry') await navigate(base(demoId));
    return;
  }
  const previous = browserSession;
  try {
    browserSession = await request<BrowserSession>('/api/browser-session/active-demo', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({demoId,expectedVersion:previous.version})}, true);
    const next = await request<DemoSession>(`/api/sessions/${demoId}`, {}, true);
    current=next; lastList=undefined; pendingTurn=undefined; lastResult=undefined; turnNote=''; chatBusy=false;
    await navigate(base(next.id));
  } catch(e) {
    await loadBrowserSession();
    toast(plain((e as Error).message));
  }
}
function positionTracePopover(anchor: HTMLElement, panel: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const workspaceElement = anchor.closest<HTMLElement>('.workspace');
  const workspace = workspaceElement?.getBoundingClientRect();
  const edge = Math.max(8, workspace?.left ?? 8);
  const right = Math.min(window.innerWidth - 8, workspace?.right ?? window.innerWidth - 8);
  const width = Math.min(260, Math.max(120, right - edge - 16));
  panel.style.position = 'fixed'; panel.style.width = `${width}px`; panel.style.margin = '0';
  panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.overflow = 'auto';
  panel.style.left = `${Math.max(edge, Math.min(rect.left, right - width))}px`;
  panel.style.maxHeight = `${Math.max(80, window.innerHeight - 24)}px`;
  const height = panel.getBoundingClientRect().height;
  const top = rect.bottom + 7 + height <= window.innerHeight - 8 ? rect.bottom + 7 : Math.max(8, rect.top - height - 7);
  panel.style.top = `${top}px`;
}
function showTraceHelp(wrapper: HTMLElement) {
  const button = wrapper.querySelector<HTMLButtonElement>('button');
  const tooltip = wrapper.querySelector<HTMLElement>('.trace-tooltip');
  if (!button || !tooltip) return;
  if (typeof tooltip.showPopover === 'function') {
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
  } else tooltip.classList.add('is-open');
  positionTracePopover(button, tooltip);
}
function hideTraceHelp(wrapper: HTMLElement) {
  const tooltip = wrapper.querySelector<HTMLElement>('.trace-tooltip');
  if (!tooltip) return;
  if (typeof tooltip.hidePopover === 'function' && tooltip.matches(':popover-open')) tooltip.hidePopover();
  tooltip.classList.remove('is-open');
}
function closeTracePopovers() {
  for (const details of root.querySelectorAll<HTMLDetailsElement>('.filter-popover[open]')) {
    const editor = details.querySelector<HTMLElement>('.filter-editor');
    if (editor && typeof editor.hidePopover === 'function' && editor.matches(':popover-open')) editor.hidePopover();
    details.open = false;
  }
  for (const wrapper of root.querySelectorAll<HTMLElement>('.trace-help')) hideTraceHelp(wrapper);
}
document.addEventListener('toggle', event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.matches('.filter-popover') || !details.isConnected) return;
  const anchor = details.querySelector<HTMLElement>('summary');
  const editor = details.querySelector<HTMLElement>('.filter-editor');
  if (!editor) return;
  if (!details.open) {
    if (typeof editor.hidePopover === 'function' && editor.matches(':popover-open')) editor.hidePopover();
    return;
  }
  for (const other of root.querySelectorAll<HTMLDetailsElement>('.filter-popover[open]')) {
    if (other === details) continue;
    const otherEditor = other.querySelector<HTMLElement>('.filter-editor');
    if (otherEditor && typeof otherEditor.hidePopover === 'function' && otherEditor.matches(':popover-open')) otherEditor.hidePopover();
    other.open = false;
  }
  if (typeof editor.showPopover === 'function' && !editor.matches(':popover-open')) editor.showPopover();
  if (anchor) positionTracePopover(anchor, editor);
}, true);
document.addEventListener('mouseover', event => {
  const wrapper = (event.target as Element).closest<HTMLElement>('.trace-help');
  if (wrapper) showTraceHelp(wrapper);
});
document.addEventListener('mouseout', event => {
  const wrapper = (event.target as Element).closest<HTMLElement>('.trace-help');
  if (wrapper && !wrapper.contains((event as MouseEvent).relatedTarget as Node | null) && !wrapper.contains(document.activeElement)) hideTraceHelp(wrapper);
});
document.addEventListener('focusin', event => {
  const wrapper = (event.target as Element).closest<HTMLElement>('.trace-help');
  if (wrapper) showTraceHelp(wrapper);
});
document.addEventListener('focusout', event => {
  const wrapper = (event.target as Element).closest<HTMLElement>('.trace-help');
  if (wrapper && !wrapper.contains((event as FocusEvent).relatedTarget as Node | null) && !wrapper.matches(':hover')) hideTraceHelp(wrapper);
});
document.addEventListener('scroll', event => {
  // Focusing a narrow filter may scroll its horizontal strip after it opens.
  // Keep the editor attached to the moved summary instead of immediately closing it.
  if (event.target instanceof Element && event.target.matches('.filter-scroll')) {
    for (const details of root.querySelectorAll<HTMLDetailsElement>('.filter-popover[open]')) {
      const anchor=details.querySelector<HTMLElement>('summary'), editor=details.querySelector<HTMLElement>('.filter-editor');
      if (anchor && editor) positionTracePopover(anchor,editor);
    }
    return;
  }
  if (event.target === document || (event.target instanceof Element && event.target.matches('.filter-scroll, .workspace, .table-scroll'))) closeTracePopovers();
}, true);
window.addEventListener('resize', closeTracePopovers);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if(activeGuidance) clearGuidance();
  const nativeHelpOpen = [...root.querySelectorAll<HTMLElement>('.trace-tooltip')].some(tooltip => typeof tooltip.showPopover === 'function' && tooltip.matches(':popover-open'));
  if (nativeHelpOpen || root.querySelector('.filter-popover[open], .trace-tooltip.is-open')) closeTracePopovers();
});
document.addEventListener('click', event => {
  const clear = (event.target as Element).closest<HTMLElement>('[data-clear-filter]');
  if (!clear || !current) return;
  event.preventDefault();
  event.stopPropagation();
  const params = new URLSearchParams(location.search);
  params.delete(clear.dataset.clearFilter!);
  navigate(`${base(current.id)}${params.size ? '?' + params : ''}`);
}, true);
document.addEventListener('click',async event=>{
  const el=(event.target as Element).closest<HTMLElement>('a,button'); if (!el || el.hasAttribute('data-clear-filter')) return;
  if(el.hasAttribute('data-routing-back')&&current){const form=root.querySelector<HTMLFormElement>('#routing-form');if(form)saveRoutingDraft(form);routingStep=Math.max(0,routingStep-1);routingPage(current);return;}
  if(el.hasAttribute('data-guidance-id')) { event.preventDefault();await showGuidance(el.dataset.guidanceMessage!,el.dataset.guidanceId!);return; }
  if(el.hasAttribute('data-guidance-dismiss')) {clearGuidance();return;}
  const traceHelp = el.closest<HTMLElement>('.trace-help');
  if (traceHelp) { event.preventDefault(); showTraceHelp(traceHelp); return; }
  if (el.hasAttribute('data-trace-guide-dismiss') || el.hasAttribute('data-trace-guide-show')) {
    if (current) { sessionStorage.setItem(traceGuideKey(current.id), el.hasAttribute('data-trace-guide-dismiss') ? 'dismissed' : 'shown'); repaint(); }
    return;
  }
  if (el.hasAttribute('data-fixed-date-range')) { toast('The demo uses a fixed date range. Filter by scenario, detections, tags or latency instead.'); return; }
  if (el.hasAttribute('data-example')) {
    if (!chatOpen && current && location.pathname.startsWith('/demo/')) { sessionStorage.removeItem(chatKey(current.id)); chatOpen = true; repaint(); }
    const input = document.querySelector<HTMLTextAreaElement>('#chat-form textarea[name="message"]');
    if (input) { input.value = el.dataset.example ?? ''; input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); }
    return;
  }
  if (el.hasAttribute('data-select-demo')) { void selectDemo(el.dataset.selectDemo ?? ''); return; }
  if (el.hasAttribute('data-add-question')) {
    const editor=document.querySelector<HTMLElement>('#eval-question-editor');
    if(editor){const rows=[...editor.querySelectorAll<HTMLElement>('[data-question-row]')];if(rows.length>=8){toast('An evaluation can have up to eight questions.');return;}const next=Math.max(-1,...rows.map(x=>Number(x.dataset.questionIndex)))+1;el.insertAdjacentHTML('beforebegin',evalQuestionRow({key:`question-${next+1}`,label:'New question',type:'text',required:false,reviewer:'buyer'},next));}
    return;
  }
  if (el.hasAttribute('data-remove-question')) {
    const editor=el.closest('#eval-question-editor');if(editor?.querySelectorAll('[data-question-row]').length===1){toast('Keep at least one question.');return;}el.closest('[data-question-row]')?.remove();return;
  }
  if (el.hasAttribute('data-eval-tab') && current && evaluation) {
    evaluationTab = el.dataset.evalTab as typeof evaluationTab;
    sessionStorage.setItem(evaluationTabKey(evaluation.evaluation.id), evaluationTab);
    evaluationPage(current,evaluation);
    return;
  }
  if (el.hasAttribute('data-choice')) { void sendChat(el.textContent ?? '', el.dataset.choice, el.dataset.confirmationRef); return; }
  if (el.hasAttribute('data-retry-draft')) { void sendChat(draft[0]?.text ?? ''); return; }
  if (el.hasAttribute('data-retry-turn')) { if (pendingTurn && !chatBusy) void runTurn(pendingTurn.request); return; }
  if (el.hasAttribute('data-end-demo')) { void endDemo(); return; }
  if (el.hasAttribute('data-discard-draft')) { saveDraft([]); for (const key of ['creation-operation','creation-payload','creation-turn-id']) sessionStorage.removeItem(key); chatBusy = false; entry(); return; }
  if (el.hasAttribute('data-chat-collapse') && current) { sessionStorage.setItem(chatKey(current.id), '1'); chatOpen = false; repaint(); return; }
  if (el.hasAttribute('data-chat-open')) { if (current) sessionStorage.removeItem(chatKey(current.id)); chatOpen = true; if (current && location.pathname.startsWith('/demo/')) repaint(); return; }
  if (el.matches('a[data-nav]') && !(event as MouseEvent).metaKey && !(event as MouseEvent).ctrlKey) {
    event.preventDefault();
    const href = (el as HTMLAnchorElement).getAttribute('href')!;
    clearGuidance('navigation',false);
    if (el.classList.contains('back-link')) {
      if (historyDepth() > 0) { history.back(); return; }
      navigate(href);
      return;
    }
    if (!location.pathname.match(/\/traces\//)) returnTo=location.pathname+location.search;
    navigate(href); return;
  }
  if (el.hasAttribute('data-rail')) {
    railOpen=!railOpen;
    if (current) {
      const trace=current.dataset.traces.find(x=>location.pathname.endsWith(x.id));
      if (trace) detail(current, trace);
      else if (lastList) list(current, lastList);
    }
    return;
  }
  if (el.hasAttribute('data-graph-select')) {event.preventDefault();graphSelection=el.dataset.graphSelect;const t=current?.dataset.traces.find(x=>location.pathname.endsWith(x.id));if(current&&t)detail(current,t);return;}
  if (el.hasAttribute('data-refresh')) { void render(); return; }
  if (el.hasAttribute('data-unavailable')) { toast('Outside this limited demo. No action was performed.'); return; }
  if (el.hasAttribute('data-theme')) { document.documentElement.classList.toggle('dark'); return; }
  if (el.id==='resume') {
    await loadBrowserSession();
    const active = entrySavedState(browserSession).activeDemo;
    if (!active) return;
    try { const s=await request<DemoSession>(`/api/sessions/${active.id}`); await navigate(base(s.id)); }
    catch { await loadBrowserSession(); toast('This saved demo is no longer available. Choose another demo or start a new one.'); }
    return;
  }
  if (!current) return;
  const t=current.dataset.traces.find(t=>location.pathname.endsWith(t.id));
  if (el.hasAttribute('data-timeline')) {timeline=!timeline; if(t) detail(current,t);}
  if (el.hasAttribute('data-graph')) {graph=!graph; if(t) detail(current,t);}
  if (el.hasAttribute('data-root')) {const id=el.dataset.root!;collapsedRoots.has(id)?collapsedRoots.delete(id):collapsedRoots.add(id);if(t)detail(current,t);}
  if (el.hasAttribute('data-expand')) { const id=el.dataset.expand!; expanded.has(id)?expanded.delete(id):expanded.add(id); if(t)detail(current,t); }
  if (el.hasAttribute('data-expand-all') && t) {for (const span of t.spans) if (span.parentId) expanded.add(span.id); detail(current,t);}
  if (el.hasAttribute('data-tags') && t) toast(t.tags.join(' · '));
  if (el.hasAttribute('data-copy') && t) {try {await navigator.clipboard.writeText(JSON.stringify(t.spans.find(s=>s.id===el.dataset.copy),null,2));toast('Span JSON copied.');}catch {toast('Clipboard unavailable; use the visible span JSON.');}}
});
function toast(message:string) { document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=message;root.append(el);setTimeout(()=>el.remove(),4500); }
document.addEventListener('submit',async event=>{
  const form=event.target as HTMLFormElement; event.preventDefault();
  if (form.id==='chat-form') { void sendChat(String(new FormData(form).get('message') ?? '')); return; }
  if(form.id==='routing-form'){void submitRouting(form);return;}
  if (form.id==='create-eval-form') { void createEvaluation(form); return; }
  if (form.id==='review-eval-form') { void saveEvaluationReview(form); return; }
  if (current && (form.id==='filters'||form.id==='search-form')) {
    const params=new URLSearchParams(location.search);new FormData(form).forEach((v,k)=>{if(String(v))params.set(k,String(v));else params.delete(k);});
    navigate(`${base(current.id)}${params.size?'?'+params:''}`);
  }
});
// Enter sends; Shift+Enter inserts a newline (and Enter while an IME is composing is left alone).
document.addEventListener('keydown',event=>{
  const el=event.target as HTMLElement;
  if (event.key!=='Enter' || event.shiftKey || event.isComposing || !(el instanceof HTMLTextAreaElement) || el.name!=='message') return;
  event.preventDefault();
  if (!el.disabled) el.form?.requestSubmit();
});
document.addEventListener('change',event=>{
  const el=event.target as HTMLInputElement;
  if(el.id==='trace-navigator' && current)navigate(`${base(current.id)}/${el.value}`);
  if(el.id==='select-all')document.querySelectorAll<HTMLInputElement>('[data-select]').forEach(x=>x.checked=el.checked);
  if(el.matches('[data-q-type]')){const options=el.closest('[data-question-row]')?.querySelector<HTMLElement>('[data-q-options]');if(options)options.hidden=el.value!=='choice';}
});
// Keep the newest message (and any clarification buttons) in view after every repaint.
new MutationObserver(() => { const thread = document.querySelector<HTMLElement>('.chat-panel .chat-thread'); if (thread) thread.scrollTop = thread.scrollHeight; }).observe(root, { childList: true });
window.addEventListener('popstate',()=>{clearGuidance('navigation',false);void render();});
window.addEventListener('pagehide',()=>stopEntryRotation());
window.addEventListener('pageshow', event => {
  if (event.persisted && location.pathname === '/entry') { stopEntryRotation(); startEntryRotation(); }
});
if (!history.state || typeof (history.state as {tailor?: unknown}).tailor !== 'number') history.replaceState({ tailor: 0 }, '');
void render();
