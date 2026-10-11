import type { ChatTurn, DemoSession, Json, Span, Trace, TraceList } from './contracts.ts';
import type { ExecutionInfoResponse, ExecutionLabel, TurnOutcome, TurnRequest, TurnResponse, TurnStep } from './agent-contract.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icon = (name: string) => {
  const paths: Record<string,string> = { list:'M5 4v16h15M9 7h10M9 11h10M9 15h10', search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', back:'M20 12H4m6-6-6 6 6 6', refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5', tool:'M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-4 3-3-3z', tree:'M8 4v16m0-12h8m-8 8h8M5 2h6v4H5zM16 6h5v4h-5zM16 14h5v4h-5z', clock:'M12 7v5l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', check:'M7 12l3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', close:'M6 6l12 12M18 6 6 18', plus:'M12 8v8M8 12h8M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', minus:'M8 12h8M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', chevron:'m8 5 7 7-7 7', sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', home:'M3 10l9-7 9 7v10H3z', message:'M4 4h16v13H9l-5 4z', bell:'M5 17h14l-2-5V8a5 5 0 0 0-10 0v4zM10 21h4', chain:'M10 13a5 5 0 0 0 7.1.4l1.8-1.8a5 5 0 0 0-7-7L10.5 6M14 11a5 5 0 0 0-7.1-.4l-1.8 1.8a5 5 0 0 0 7 7L13.5 18', shield:'M12 3 5 6v6c0 4.2 2.8 6.8 7 8.5 4.2-1.7 7-4.3 7-8.5V6z', retrieval:'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5', doc:'M7 3h8l5 5v13H7zM15 3v5h5M10 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12.2 16.2 15 19', rocket:'M12 19c-4-1-6-5-6-9 3 0 6-3 7-6 1 3 4 6 7 6-1 4-3 8-8 9zM12 11h.01M8 17l-2 4M16 17l2 4' };
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
let turnNote = '';
let entryNotice = '';
let ended = false;
let restoreText = '';
let lastList: TraceList | undefined;
const collapsedRoots = new Set<string>();
const expanded = new Set<string>();
let returnTo = '';
const link = (path: string,label: string,cls='')=>`<a data-nav href="${esc(path)}" class="${cls}">${label}</a>`;
const base = (id: string) => `/demo/${id}/traces`;
const traceLink = (t: Trace) => `${base(t.sessionId)}/${t.id}`;
function historyDepth() {
  const state = history.state as { tailor?: unknown } | null;
  return state && typeof state.tailor === 'number' ? state.tailor : 0;
}
function navigate(path: string): Promise<void> { history.pushState({ tailor: historyDepth() + 1 },'',path); return render(); }
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
  for (const key of Object.keys(sessionStorage)) if (key.startsWith('tailor-chat-collapsed:') || key.startsWith('tailor-exec:') || key.startsWith('tailor-steps:')) sessionStorage.removeItem(key);
  draft = []; pendingTurn = undefined; lastResult = undefined; turnNote = ''; chatBusy = false; current = undefined; lastList = undefined;
}
function showEnded() {
  ended = true; generation++; controller?.abort();
  clearLocalState();
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  root.innerHTML = `<main class="ended" role="alert"><h1>This demo has ended</h1><p>Your conversation and demo data were deleted. Nothing from this session is kept.</p>${link('/entry','Start a new demo','solid')}</main>`;
}
/** Friendly page for a demo this browser cannot open (ended, expired in another tab, or someone else's). No raw codes. */
function showUnavailable() {
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
    if (isEnded(failure)) showEnded();
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
const execChip = () => execution?.mode === 'mock' ? 'Mock-backed' : execution?.mode === 'live' ? `Live model${execution.model ? ` · ${execution.model}` : ''}` : 'Provider status unavailable';
const execLine = () => execution?.mode === 'mock' ? 'Mock-backed prototype — no live model yet' : execution?.mode === 'live' ? `Live model${execution.model ? ` · ${execution.model}` : ''}` : 'Provider status unavailable';
const execClass = () => execution?.mode === 'mock' ? 'chat-mock' : execution?.mode === 'live' ? 'chat-live' : 'chat-unknown';
/** Updates the label in place so typing in the composer is never disturbed. */
function paintExecution() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-exec-chip]')) el.textContent = execChip();
  for (const el of document.querySelectorAll<HTMLElement>('[data-exec-line]')) { el.textContent = execLine(); el.classList.remove('chat-mock', 'chat-live', 'chat-unknown'); el.classList.add(execClass()); }
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
  const expanded = `<div class="rail-switch"><button type="button" data-unavailable>console</button><button type="button" data-chat-open>chats</button></div><div class="rail-project"><span>Synthetic demo</span></div>${labeled('rocket','setup','<em>1/2</em>')}<nav class="rail-menu" aria-label="Project">${labeled('home','home')}${labeled('bell','incidents')}${traces}${labeled('tool','detections')}${labeled('bell','alerts')}${labeled('tree','analytics')}${labeled('search','evals')}${labeled('tool','experiments','<em>beta</em>')}</nav>`;
  const opener = chatOpen ? '' : `<div class="chat-reopen"><button type="button" data-chat-open>Open conversation</button><button type="button" data-end-demo class="end-demo">End demo</button></div>`;
  return `<aside class="rail${railOpen?' is-labeled':''}"><a data-nav href="/" class="mark" aria-label="Landing page">n</a><button type="button" class="rail-toggle" data-rail aria-expanded="${railOpen}" aria-label="${railOpen?'Collapse sidebar':'Expand sidebar'}">${icon(railOpen?'back':'chevron')}</button><div class="rail-collapsed-only">${collapsed}</div>${railOpen?expanded:''}<div class="rail-bottom"><button data-theme aria-label="Toggle local theme">${icon('sun')}</button></div></aside><div class="workspace">${opener}${content}</div>${chatOpen ? chatPanel(s) : ''}`;
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
    const choices = turn.clarification && i === lastIndex ? `<div class="chat-choices" role="group" aria-label="Choose one">${turn.clarification.choices.map(c => `<button type="button" data-choice="${esc(c.id)}" ${chatBusy ? 'disabled' : ''}>${esc(c.label)}</button>`).join('')}</div><small>or type your own answer below</small>` : '';
    const retry = pendingTurn && pendingTurn.turn.id === turn.id && (turn.status === 'failed' || turn.status === 'uncertain') && !chatBusy ? `<button type="button" class="chat-retry" data-retry-turn>Retry</button>` : '';
    return `<article class="chat-turn is-${turn.role}${turn.status === 'uncertain' ? ' is-uncertain' : ''}" data-status="${turn.status}"${label === 'Declined' ? ' data-declined' : ''}><p>${esc(turn.role === 'tailor' ? buyerText(turn.text) : turn.text)}</p>${label ? `<small class="turn-status">${label}</small>` : ''}${retry}${evidence}${choices}</article>`;
  }).join('');
}
/** Buyer-language summary of what the last turn did. Internal step names are never shown. */
function stepsLine(steps: TurnStep[], outcome?: TurnOutcome) {
  const parts: string[] = [];
  const push = (text: string) => { if (parts[parts.length - 1] !== text) parts.push(text); };
  for (const step of steps) {
    if (step.status === 'skipped') continue;
    const failed = step.status === 'failed';
    switch (step.name) {
      case 'load_context': case 'retrieve_knowledge': push(failed ? 'Could not check ✕' : 'Checked'); break;
      case 'validate': push(failed ? 'Checks failed ✕' : 'Checked'); break;
      case 'model': push(failed ? 'Could not finish ✕' : 'Checked'); break;
      case 'save': push(failed ? (outcome === 'readback_uncertain' ? 'Save not confirmed ✕' : 'Not saved ✕') : 'Saved'); break;
      case 'readback': if (!(failed && parts[parts.length - 1] === 'Save not confirmed ✕')) push(failed ? 'Could not verify ✕' : 'Verified ✓'); break;
      case 'explain': push(failed ? 'Could not read the trace ✕' : 'Read the trace'); break;
      case 'repair': push('Fixed a problem'); break;
      case 'escalate': push('Asked for a second opinion'); break;
    }
  }
  return parts.join(' · ');
}
function progress() {
  if (chatBusy) return `<p class="chat-steps" role="status">Working on it…</p>`;
  const line = lastResult ? stepsLine(lastResult.steps, lastResult.outcome) : '';
  const uncertain = lastResult?.outcome === 'readback_uncertain';
  return `${turnNote ? `<p class="chat-note${uncertain ? ' is-uncertain' : ''}" role="status">${esc(turnNote)}</p>` : ''}${line ? `<p class="chat-steps" aria-label="What I did">${esc(line)}</p>` : ''}`;
}
function composer(busy: boolean, asking?: Trace) {
  const text = restoreText; restoreText = '';
  const about = asking ? `<p class="chat-asking" data-asking-about="${esc(asking.id)}" title="${esc(asking.id)}">Asking about: ${esc(asking.label)}</p>` : '';
  return `<form id="chat-form" class="chat-composer">${about}<textarea name="message" aria-label="Ask anything" placeholder="Describe your agent or ask a question…" maxlength="2000" rows="2" ${busy?'disabled':''}>${esc(text)}</textarea><div class="chat-tools"><span class="chat-chip">Synthetic data</span><span class="chat-chip" data-exec-chip>${esc(execChip())}</span><button type="submit" aria-label="Send message" ${busy?'disabled':''}>${icon('chevron')}</button></div></form>`;
}
/** `starting` = no personalised demo yet: offer ways to begin, not follow-ups about data that does not exist. */
function examples(starting: boolean) {
  const items = starting
    ? ['I’m building a customer-support agent. Show a refund lookup that times out, then a retry that succeeds.', 'I’m building an insurance claims bot. The OCR tool returns bad data and a guardrail blocks the payout.']
    : ['Explain this trace', 'Make the retry fail too'];
  return `<div class="chat-examples">${items.map(x => `<button type="button" data-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>`;
}
function honestLines() {
  return `<p class="chat-label">Powered by Tailor · synthetic data</p><p class="chat-label ${execClass()}" data-exec-line>${esc(execLine())}</p>`;
}
function chatPanel(s: DemoSession) {
  const turns = turnsOf(s);
  return `<aside class="chat-panel" aria-label="Conversation"><header><strong>chats</strong><span class="chat-actions"><button type="button" data-end-demo class="end-demo">End demo</button><button type="button" data-chat-collapse aria-label="Collapse conversation">${icon('close')}</button></span></header>${honestLines()}<div class="chat-thread">${turns.length?chatThread(turns, s):`<p class="chat-empty">Describe the agent you’re building, or ask me to explain the open trace.</p>`}</div>${progress()}${examples(s.story === null)}${composer(chatBusy, openTrace(s))}</aside>`;
}
function landing() {
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  const item = (n: string) => n === 'Manifesto'
    ? `<button data-unavailable class="nav-current"><i class="nav-dot" aria-hidden="true"></i>${n}</button>`
    : n === 'Product' ? `<button data-unavailable class="nav-caret">${n}</button>`
    : n === 'Docs' ? `<button data-unavailable class="nav-out">${n}</button>`
    : `<button data-unavailable>${n}</button>`;
  root.innerHTML = `<div class="landing"><div class="hack"><span class="hack-date">Oct 10–12</span> Join neatHack · $19,000 in prizes & credits ↗</div><header class="public-nav">${link('/','neatlogs','wordmark')}<nav>${['Manifesto','Product','Pricing','Docs','Blog','Changelog','Careers'].map(item).join('')}<span class="nav-rule" aria-hidden="true"></span>${link('/entry','Try with your project ↗','solid')}</nav></header><main class="hero"><picture><source media="(max-width:600px)" srcset="/assets/portrait.webp"><img src="/assets/landscape.webp" alt="San Francisco skyline and bridge in silver fog"></picture><div class="hero-copy"><h1><span>Your agent is already running.</span><br>That’s not the same as working</h1><p>neatlogs finds what’s failing, works out why, and hands you a fix.</p><div class="hero-actions"><button class="setup" data-unavailable><span class="setup-border" aria-hidden="true"><span class="setup-comet"></span></span><span class="agent-symbols" aria-hidden="true"><img src="/assets/claude-color.svg" alt="" title="Claude Code"><img src="/assets/codex-symbol.svg" alt="" title="Codex"><img src="/assets/cursor-symbol.svg" alt="" title="Cursor"></span><span class="setup-label">Copy setup prompt</span><svg class="setup-copy" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg></button>${link('/entry','Try with your project ↗','outline')}</div></div></main><footer class="landing-foot">Tailor proof of concept · limited Neatlogs replica · fictional projects only. ${link('/entry','Explore the demo')}</footer></div>`;
}
function entry() {
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  void loadExecution();
  const turns = draft;
  const started = turns.length > 0;
  const banner = entryNotice ? `<p class="entry-notice" role="status">${esc(entryNotice)}</p>` : '';
  root.innerHTML = `<div class="chat-home"><header class="entry-nav">${link('/','neatlogs','wordmark')}${link('/','← Back to landing')}</header><div class="chat-stage">${banner}<p class="chat-label">Powered by Tailor · synthetic data</p><p class="chat-label ${execClass()}" data-exec-line>${esc(execLine())}</p>${started?`<div class="chat-thread">${chatThread(turns)}</div>`:`<h1>hello</h1><p>Describe the agent or workflow you’re building. I’ll show you a fictional failure for it.</p>`}${chatBusy?`<p class="chat-steps" role="status">Setting up your demo…</p>`:''}${composer(chatBusy)}${examples(true)}${started?`${turns[turns.length-1]!.status==='failed'?`<button type="button" data-retry-draft>Retry</button> `:''}<button type="button" data-discard-draft>Discard draft</button>`:`<button type="button" id="resume">Resume this browser’s saved session</button>`}<p class="form-error" role="alert"></p></div></div>`;
}
function list(s: DemoSession,data: TraceList) {
  lastList = data;
  const query = new URLSearchParams(location.search);
  const chip = (key: string) => query.get(key) ? `<button type="button" class="chip-remove" data-clear-filter="${key}" aria-label="Remove ${key} filter">×</button>` : '';
  const select = (key:string,label:string,options:string[][])=>`<details class="filter-popover${query.get(key)?' is-selected':''}"><summary>${label}${query.get(key)?` · ${esc(options.find(([v])=>v===query.get(key))?.[1] ?? query.get(key))}`:''}${chip(key)}⌄</summary><div class="filter-editor"><label>${label}<select name="${key}" aria-label="${label}"><option value="">All</option>${options.map(([v,l])=>`<option value="${esc(v)}" ${query.get(key)===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label><button type="submit">Apply filters</button></div></details>`;
  const rows = data.traces.map(t=>{
    const when = ingested(t.ingestedAt);
    const found = t.spans.filter(span => span.detection).length;
    const isActive = s.story !== null && t.scenario === data.activeScenario;
    const active = isActive ? ' is-active-fixture' : '';
    return `<tr class="${active.trim()}" data-trace="${t.id}"><td><input type="checkbox" aria-label="Select ${t.scenario}" data-select></td><td class="mono">${link(traceLink(t),`<span>${esc(when.time)}</span> <small>${esc(when.date)}</small><span class="mobile-fixture">${esc(t.label)}</span>`)}</td><td><span class="ready" title="Ready means processed; task outcome is separate">${icon('check')}<span class="sr">Ready</span></span></td><td>${found?`<span class="failure">Execution Failed &nbsp; ${found}</span>`:'–'}</td><td>—</td><td>${link(traceLink(t),`${esc(t.label)} · ${esc(s.story?.domain ?? 'sample workflow')}${isActive?'<span class="active-tag">Active</span>':s.story===null?'<span class="active-tag">Sample</span>':''}`)}</td><td>${link(traceLink(t),io(t.output).replace(/<br>/g,' '))}</td><td>—</td><td><button data-unavailable aria-label="Replay is outside this demo">${icon('clock')}</button></td></tr>`;
  }).join('');
  const days = ['Sep 28','','Sep 30','','Oct 2','','','Oct 5','','Oct 7','','Oct 9','','Oct 11'];
  root.innerHTML = shell(s,`<header class="list-header"><h1>${icon('list')}Traces</h1><div class="header-controls"><button class="active">Traces</button><button data-unavailable>Sessions</button><button data-unavailable>Users</button><details class="search-popover" ${query.get('q')?'open':''}><summary aria-label="Search traces">${icon('search')}</summary><form id="search-form"><input name="q" aria-label="Search traces" placeholder="Search traces…" value="${esc(query.get('q') ?? '')}"></form></details><button data-unavailable>Last 14 days⌄</button><button data-refresh aria-label="Refresh traces">${icon('refresh')}</button></div></header><form id="filters" class="filters">${['Session ID','User ID'].map(n=>`<button type="button" data-unavailable class="filter">${n}⌄</button>`).join('')}${select('scenario','Scenario',s.dataset.traces.map(t=>[t.scenario,t.label]))}${select('detection','Detections',[['yes','Execution Failed'],['no','No detections']])}<button type="button" data-unavailable class="filter">Evals⌄</button>${select('tag','Tags',[...new Set(s.dataset.traces.flatMap(t=>t.tags))].map(x=>[x,x]))}<details class="filter-popover${query.get('minMs')?' is-selected':''}"><summary>Latency${query.get('minMs')?` ≥ ${esc(query.get('minMs'))}ms`:''}${chip('minMs')}⌄</summary><div class="filter-editor"><label>Minimum latency in milliseconds<input name="minMs" type="number" min="0" step="0.1" aria-label="Minimum latency in milliseconds" value="${esc(query.get('minMs') ?? '')}" placeholder="ms"></label><button type="submit">Apply filters</button></div></details><button type="button" data-unavailable class="filter">Metadata⌄</button><button type="button" data-unavailable class="filter">More filters⌄</button><button type="button" data-unavailable class="filter">＋ Advanced</button>${link(base(s.id),'Clear')}</form><div class="histogram" aria-label="${data.filtered} filtered traces on Oct 10">${days.map((label,i)=>{const count=i===12?data.filtered:0;return `<div class="day" style="--count:${count}" title="${count} traces">${count?`<i class="day-bar" style="--count:${count}"></i>`:''}<span>${label}</span></div>`;}).join('')}</div><div class="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select all traces" id="select-all"></th>${['Ingested at','Status','Detections','Evals','Input','Output','Comments','Replay'].map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty"><div class="empty-mark">${icon('doc')}</div><h2>No traces found</h2><p>Try adjusting your filters or date range.</p>${link(base(s.id),'Clear filters','empty-clear')}</td></tr>`}</tbody></table></div>${notice(s)}<footer class="pagination"><label>Rows per page <select aria-label="Rows per page"><option>25</option></select></label><span data-count>${data.filtered?`1 – ${data.filtered}`:'0'} of ${data.filtered}</span><button disabled aria-label="Previous page">‹</button><button class="active">1</button><button disabled aria-label="Next page">›</button></footer>`);
}
function spanRow(t:Trace,s:Span,selected:string|null):string {
  const open = expanded.has(s.id) || s.id===selected;
  const detection = s.detection ? (graph ? '<span class="span-detection is-dot" aria-label="Execution Failed"></span>' : '<span class="span-detection failure">Execution Failed</span>') : '';
  return `<div class="span-row ${s.parentId?'child':''} ${s.id===selected?'selected-span':''}" data-span-id="${s.id}" style="--depth:${s.parentId?1:0}"><button class="span-head" ${s.parentId?'data-expand':'data-root'}="${s.id}" aria-expanded="${s.parentId?open:!collapsedRoots.has(s.id)}">${icon((s.parentId?open:!collapsedRoots.has(s.id))?'minus':'plus')}${icon(s.status==='ERROR'?'close':s.kind==='TOOL'?'tool':'tree')}<span>${esc(s.name)}</span><small>${s.kind}</small>${s.status==='ERROR'?'<b class="error-text">ERROR</b>':''}<time>${durationLabel(s.durationMs)}</time></button>${detection}${open?`<div class="span-content"><div class="span-actions">${link(`${traceLink(t)}?span=${s.id}`,'Link to span')}<button data-copy="${s.id}">Copy span JSON</button></div><label>INPUT</label><pre>${esc(JSON.stringify(s.input,null,2))}</pre>${s.error?`<label class="error-text">ERROR</label><pre class="error-box">${esc(s.error)}</pre>`:`<label>OUTPUT</label><pre>${esc(JSON.stringify(s.output,null,2))}</pre>`}<details class="span-attributes"><summary>Attributes · timing and IDs</summary><dl><dt>Start offset</dt><dd>${s.startMs} ms</dd><dt>Duration</dt><dd>${durationLabel(s.durationMs)}</dd><dt>Span ID</dt><dd>${s.id}</dd><dt>Parent ID</dt><dd>${s.parentId ?? 'Root'}</dd></dl></details></div>`:''}</div>`;
}
function detail(s:DemoSession,t:Trace) {
  const selected = new URLSearchParams(location.search).get('span');
  if (selected && !t.spans.some(x=>x.id===selected)) throw new Error('NOT_FOUND: Span not found in this trace.');
  const path = traceLink(t);
  const back = returnTo.startsWith(base(s.id)) && !returnTo.slice(base(s.id).length).startsWith('/') ? returnTo : base(s.id);
  const graphNode = (x: Span) => `<a href="${path}?span=${x.id}" data-graph-select="${x.id}" class="${kindClass(x.kind)} ${graphSelection===x.id?'graph-selected':''}">${icon(kindMark(x.kind))}${x.status==='ERROR'?`<span class="error-x">${icon('close')}</span>`:''}${esc(x.name)}</a>`;
  root.innerHTML=shell(s,`<header class="detail-header">${link(back,icon('back'),'back-link')}<span>${esc(ingested(t.ingestedAt).heading)}</span><div><button data-unavailable aria-label="Search this trace">${icon('search')}</button><button data-unavailable aria-label="Replay unavailable">${icon('clock')}</button><button data-unavailable aria-label="Comments unavailable">${icon('message')}</button><button data-tags>${t.tags.length} tags</button><button data-unavailable>Ask neat AI</button></div></header><div class="trace-toolbar"><details class="trace-picker"><summary aria-label="Trace navigator">${icon('list')}<span>${esc(t.name)}</span><small>${t.spans.length}</small>${icon('chevron')}</summary><nav aria-label="Synthetic trace choices">${s.dataset.traces.map(x=>link(traceLink(x),`${esc(x.label)} · ${x.spans[0]!.durationMs}ms · ${x.spans.length} spans`,x.id===t.id?'active':'')).join('')}</nav></details><button data-graph aria-pressed="${graph}" aria-label="Toggle span tree">${icon('tree')}</button><button data-timeline aria-pressed="${timeline}" aria-label="Toggle timeline">${icon('list')}</button><span class="trace-identity">${esc(t.name)} · ${t.spans.length} spans</span></div><main class="trace-canvas ${timeline?'with-timeline':''}">${graph?`<div class="graph-tree" aria-label="Span parent tree"><div class="graph-nodes"><svg class="graph-connectors" viewBox="0 0 360 360" preserveAspectRatio="none" aria-hidden="true">${t.spans.slice(1).map((_,i)=>`<path d="M140 32 C175 32 175 ${32+i*64} 205 ${32+i*64}"/>`).join('')}</svg><strong class="${kindClass(t.spans[0]!.kind)}">${icon(kindMark(t.spans[0]!.kind))}${esc(t.spans[0]!.name)}</strong><div class="graph-children">${t.spans.slice(1).map(graphNode).join('')}</div></div></div>`:''}<section class="trace-flow"><div class="root-input"><label>INPUT</label><div class="input-bubble">${io(t.input)}</div></div><div class="steps"><header><span>${t.spans.length} STEPS · ${t.spans[0]!.durationMs/1000}S</span><button data-expand-all>EXPAND ALL</button></header>${t.spans.filter(x=>!x.parentId||!collapsedRoots.has(x.parentId)).map(x=>spanRow(t,x,selected)).join('')}</div><div class="root-output"><label>OUTPUT</label><p>${io(t.output)}</p></div></section></main>${timeline?`<section class="timeline" aria-label="Trace timeline"><header>TIMELINE · ${t.spans[0]!.durationMs} ms</header>${t.spans.map(x=>`<div class="timeline-row ${graphSelection===x.id?'graph-selected':''}"><a data-nav href="${path}?span=${x.id}">${esc(x.name)}</a><div class="time-track"><a data-nav aria-label="Select ${esc(x.name)} in timeline" href="${path}?span=${x.id}" class="time-bar ${x.status==='ERROR'?'bad':''}" style="left:${x.startMs/t.spans[0]!.durationMs*100}%;width:${Math.max(0.5,x.durationMs/t.spans[0]!.durationMs*100)}%"></a></div><time>${durationLabel(x.durationMs)}</time></div>`).join('')}</section>`:''}${notice(s)}`);
}
async function render() {
  const run = ++generation; controller?.abort(); controller = new AbortController(); ended = false;
  void loadExecution();
  if (location.pathname==='/') { landing(); return; }
  if (location.pathname==='/entry') { entry(); return; }
  document.documentElement.classList.remove('chat-dock');
  root.innerHTML='<main class="loading" role="status">Loading synthetic traces…</main>';
  try {
    const route = /^\/demo\/([^/]+)\/traces(?:\/([^/]+))?$/.exec(location.pathname);
    if (!route) throw new Error('NOT_FOUND: Page not found.');
    const s = await request<DemoSession>(`/api/sessions/${route[1]}`);
    if (run!==generation) return; current=s; chatOpen = sessionStorage.getItem(chatKey(s.id)) !== '1';
    restorePending(s);
    restoreSteps(s);
    if (route[2]) {
      const t=s.dataset.traces.find(t=>t.id===route[2]); if (!t) throw new Error('NOT_FOUND: Trace not found in this session.');
      detail(s,t);
    } else {
      const data=await request<TraceList>(`/api/sessions/${s.id}/traces${location.search}`);
      if (run!==generation) return;
      // Publication racing the two reads: retry against a coherent version.
      if (data.version!==s.version) { void render(); return; }
      list(s,data);
    }
  } catch(e) {
    if (run!==generation || (e as Error).name==='AbortError') return;
    if (e instanceof ApiFailure && (e.status===404 || e.status===403)) { showUnavailable(); return; }
    document.documentElement.classList.remove('chat-dock');
    root.innerHTML=`<main class="ended request-error"><h1>Demo unavailable</h1><p role="alert">${esc(plain((e as Error).message))}</p><button data-refresh>Retry</button> ${link('/entry','Create a fictional session')}</main>`;
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
async function applyResponse(response: TurnResponse) {
  if (!current) return;
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
  if (!current) return;
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
  repaint();
}
const RETRY_COPY = 'Retrying re-sends the same request; the server recognises it and will not apply it twice.';
async function runTurn(req: TurnRequest) {
  const s = current;
  if (!s) return;
  chatBusy = true; turnNote = '';
  if (pendingTurn) pendingTurn = { ...pendingTurn, turn: { ...pendingTurn.turn, status: 'pending' } };
  // The base conversation version lets a reload tell "never reached the server" from "answered meanwhile"; it survives retries.
  let base = s.conversationVersion;
  try { const earlier = JSON.parse(sessionStorage.getItem('tailor-pending-turn') ?? 'null') as StoredTurn | null; if (earlier && earlier.clientTurnId === req.clientTurnId && earlier.baseConversationVersion !== undefined) base = earlier.baseConversationVersion; } catch { /* ignore */ }
  sessionStorage.setItem('tailor-pending-turn', JSON.stringify({ sessionId: s.id, baseConversationVersion: base, ...req }));
  repaint();
  let response: TurnResponse;
  try {
    response = await request<TurnResponse>(`/api/sessions/${s.id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }, true);
  } catch (e) {
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
  if (ended) return;
  execution = response.execution; paintExecution();
  lastResult = { steps: response.steps, outcome: response.outcome };
  try { sessionStorage.setItem(stepsKey(s.id), JSON.stringify({ clientTurnId: req.clientTurnId, steps: response.steps, outcome: response.outcome })); } catch { /* quota: the strip is optional */ }
  await applyResponse(response);
}
async function sendTurn(text: string, choiceId?: string) {
  if (!current || chatBusy) return;
  const retryable = pendingTurn && (pendingTurn.turn.status === 'failed' || pendingTurn.turn.status === 'uncertain');
  const kept = retryable && pendingTurn!.request.text === text && pendingTurn!.request.choiceId === choiceId ? pendingTurn!.request : undefined;
  const open = openTrace(current);
  const req: TurnRequest = kept ?? { text, clientTurnId: crypto.randomUUID(), ...(choiceId ? { choiceId } : {}), ...(open ? { openTraceId: open.id } : {}) };
  pendingTurn = { turn: stamp('buyer', text, 'pending'), request: req };
  await runTurn(req);
}
async function startSession(text: string) {
  chatBusy = true;
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
  try {
    created = await request<DemoSession>('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation }, body: payload }, true);
  } catch (e) {
    chatBusy = false;
    if (isEnded(e) || ended) return;
    saveDraft(draft.map(t => ({ ...t, status: 'failed' as const })));
    entry();
    const failure = e instanceof ApiFailure ? e : undefined;
    const copy = !failure ? 'Tailor could not reach the server; your message was not sent. Send again to retry.'
      : failure.status >= 500 ? 'Tailor hit a server error and can’t confirm whether your demo was created. Send again; the server recognises the same request and will not create it twice.'
      : `${plain(failure.message)} Nothing was created. Send again to retry.`;
    document.querySelector('.form-error')?.replaceChildren(document.createTextNode(copy));
    return;
  }
  for (const key of ['creation-operation', 'creation-payload', 'creation-turn-id', 'tailor-draft-chat']) sessionStorage.removeItem(key);
  draft = [];
  current = created; lastList = undefined; lastResult = undefined; turnNote = '';
  chatOpen = true; sessionStorage.removeItem(chatKey(created.id));
  const req: TurnRequest = { text, clientTurnId: firstTurnId };
  pendingTurn = { turn: stamp('buyer', text, 'pending'), request: req };
  chatBusy = true;
  await navigate(base(created.id));
  await runTurn(req);
}
async function sendChat(text: string, choiceId?: string) {
  const message = text.trim();
  if (!message || chatBusy) return;
  entryNotice = '';
  if (location.pathname === '/entry' || !current) await startSession(message);
  else await sendTurn(message, choiceId);
}
async function endDemo() {
  if (!current) return;
  const id = current.id;
  try { await request(`/api/sessions/${id}/end`, { method: 'POST' }, true); }
  catch (e) { if (isEnded(e)) return; toast('Couldn’t end the demo just now. Nothing was deleted; try again.'); return; }
  clearLocalState();
  entryNotice = 'Demo ended. Your conversation and demo data were deleted.';
  navigate('/entry');
}
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
  if (el.hasAttribute('data-example')) { void sendChat(el.dataset.example ?? ''); return; }
  if (el.hasAttribute('data-choice')) { void sendChat(el.textContent ?? '', el.dataset.choice); return; }
  if (el.hasAttribute('data-retry-draft')) { void sendChat(draft[0]?.text ?? ''); return; }
  if (el.hasAttribute('data-retry-turn')) { if (pendingTurn && !chatBusy) void runTurn(pendingTurn.request); return; }
  if (el.hasAttribute('data-end-demo')) { void endDemo(); return; }
  if (el.hasAttribute('data-discard-draft')) { saveDraft([]); for (const key of ['creation-operation','creation-payload','creation-turn-id']) sessionStorage.removeItem(key); chatBusy = false; entry(); return; }
  if (el.hasAttribute('data-chat-collapse') && current) { sessionStorage.setItem(chatKey(current.id), '1'); chatOpen = false; repaint(); return; }
  if (el.hasAttribute('data-chat-open')) { if (current) sessionStorage.removeItem(chatKey(current.id)); chatOpen = true; if (current && location.pathname.startsWith('/demo/')) repaint(); return; }
  if (el.matches('a[data-nav]') && !(event as MouseEvent).metaKey && !(event as MouseEvent).ctrlKey) {
    event.preventDefault();
    const href = (el as HTMLAnchorElement).getAttribute('href')!;
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
  if (el.id==='resume') { try {const s=await request<DemoSession>('/api/session');navigate(base(s.id));} catch(e){toast(plain((e as Error).message));} return; }
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
});
// Keep the newest message (and any clarification buttons) in view after every repaint.
new MutationObserver(() => { const thread = document.querySelector<HTMLElement>('.chat-panel .chat-thread'); if (thread) thread.scrollTop = thread.scrollHeight; }).observe(root, { childList: true });
window.addEventListener('popstate',()=>void render());
if (!history.state || typeof (history.state as {tailor?: unknown}).tailor !== 'number') history.replaceState({ tailor: 0 }, '');
void render();
