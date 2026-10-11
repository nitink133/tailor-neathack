import { ADAPTER_LABEL, adapt } from './adapter.ts';
import type { ChatTurn, DemoSession, Json, Scenario, Span, Trace, TraceList } from './contracts.ts';

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
function navigate(path: string) { history.pushState({ tailor: historyDepth() + 1 },'',path); void render(); }
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
async function request<T>(path: string, init: RequestInit = {}, durable = false): Promise<T> {
  const response = await fetch(path, durable ? init : {...init,signal:controller?.signal});
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error?.code ?? response.status}: ${data.error?.message ?? 'Request failed.'}`);
  return data as T;
}
const io = (value: Json) => value && typeof value==='object' && !Array.isArray(value)
  ? Object.entries(value).map(([k,v])=>`${esc(k)}: ${esc(typeof v==='object' ? JSON.stringify(v) : v)}`).join('<br>') : esc(JSON.stringify(value));
function notice(s: DemoSession) {
  return `<div class="demo-notice">Synthetic local demo · two deterministic fixtures · text is saved, not personalized <span>v${s.version} · active fixture: ${s.dataset.activeScenario}</span></div>`;
}
function loadDraft(): ChatTurn[] {
  try { const parsed = JSON.parse(sessionStorage.getItem('tailor-draft-chat') ?? '[]') as ChatTurn[]; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveDraft(turns: ChatTurn[]) { draft = turns; sessionStorage.setItem('tailor-draft-chat', JSON.stringify(turns)); }
function chatKey(id: string) { return `tailor-chat-collapsed:${id}`; }
function turnsOf(s?: DemoSession) { return s?.conversation?.length ? s.conversation : s ? [] : draft; }
function shell(s: DemoSession,content: string) {
  document.documentElement.classList.toggle('rail-open', railOpen);
  document.documentElement.classList.toggle('chat-dock', chatOpen);
  const quiet = (name: string) => `<button type="button" class="rail-button" data-unavailable aria-label="${name} — outside this demo">${icon(name)}</button>`;
  const labeled = (name: string, label: string, extra = '') => `<button type="button" class="rail-button" data-unavailable aria-label="${label} — outside this demo">${icon(name)}<span class="rail-label">${label}</span>${extra}</button>`;
  const traces = link(base(s.id), `${icon('list')}<span class="rail-label">traces</span>`, 'rail-button selected');
  const collapsed = `${['message','tree','home','tool'].map(quiet).join('')}${link(base(s.id), icon('list'), 'rail-button selected')}${['search','bell'].map(quiet).join('')}`;
  const expanded = `<div class="rail-switch"><button type="button" data-unavailable>console</button><button type="button" data-chat-open>chats</button></div><div class="rail-project"><span>Synthetic demo</span></div>${labeled('rocket','setup','<em>1/2</em>')}<nav class="rail-menu" aria-label="Project">${labeled('home','home')}${labeled('bell','incidents')}${traces}${labeled('tool','detections')}${labeled('bell','alerts')}${labeled('tree','analytics')}${labeled('search','evals')}${labeled('tool','experiments','<em>beta</em>')}</nav>`;
  const opener = chatOpen ? '' : `<button type="button" data-chat-open class="chat-reopen">Open conversation</button>`;
  return `<aside class="rail${railOpen?' is-labeled':''}"><a data-nav href="/" class="mark" aria-label="Landing page">n</a><button type="button" class="rail-toggle" data-rail aria-expanded="${railOpen}" aria-label="${railOpen?'Collapse sidebar':'Expand sidebar'}">${icon(railOpen?'back':'chevron')}</button><div class="rail-collapsed-only">${collapsed}</div>${railOpen?expanded:''}<div class="rail-bottom"><button data-theme aria-label="Toggle local theme">${icon('sun')}</button></div></aside><div class="workspace">${opener}${content}</div>${chatOpen ? chatPanel(s) : ''}`;
}
function chatThread(turns: ChatTurn[]) {
  return turns.map(turn => `<article class="chat-turn is-${turn.role}" data-status="${turn.status}"><p>${esc(turn.text)}</p>${turn.role==='buyer' && turn.status!=='note' ? `<small>${turn.status==='pending'?'Pending':turn.status==='applied'?'Applied':'Failed'}</small>` : ''}</article>`).join('');
}
function composer(busy: boolean) {
  return `<form id="chat-form" class="chat-composer"><textarea name="message" aria-label="Ask anything" placeholder="Ask anything..." maxlength="2000" rows="2" ${busy?'disabled':''}></textarea><div class="chat-tools"><span class="chat-chip">Two fixtures</span><span class="chat-chip">${ADAPTER_LABEL}</span><button type="submit" aria-label="Send message" ${busy?'disabled':''}>${icon('chevron')}</button></div></form>`;
}
function examples() {
  return `<div class="chat-examples"><button type="button" data-example="First attempt fails, retry recovers">First attempt fails, retry recovers</button><button type="button" data-example="Both attempts fail, safely escalate">Both attempts fail, safely escalate</button></div>`;
}
function chatPanel(s: DemoSession) {
  const turns = turnsOf(s);
  return `<aside class="chat-panel" aria-label="Conversation"><header><strong>chats</strong><button type="button" data-chat-collapse aria-label="Collapse conversation">${icon('close')}</button></header><p class="chat-label">${ADAPTER_LABEL} — not an agent</p><div class="chat-thread">${turns.length?chatThread(turns):`<p class="chat-empty">The same conversation continues here. Ask to switch fixture or explain the open trace.</p>`}</div>${examples()}${composer(chatBusy)}</aside>`;
}
function landing() {
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  const item = (n: string) => n === 'Manifesto'
    ? `<button data-unavailable class="nav-current"><i class="nav-dot" aria-hidden="true"></i>${n}</button>`
    : n === 'Product' ? `<button data-unavailable class="nav-caret">${n}</button>`
    : n === 'Docs' ? `<button data-unavailable class="nav-out">${n}</button>`
    : `<button data-unavailable>${n}</button>`;
  root.innerHTML = `<div class="landing"><div class="hack"><span class="hack-date">Oct 10–12</span> Join neatHack · $19,000 in prizes & credits ↗</div><header class="public-nav">${link('/','neatlogs','wordmark')}<nav>${['Manifesto','Product','Pricing','Docs','Blog','Changelog','Careers'].map(item).join('')}<span class="nav-rule" aria-hidden="true"></span>${link('/entry','Try with your project ↗','solid')}</nav></header><main class="hero"><picture><source media="(max-width:600px)" srcset="/assets/portrait.webp"><img src="/assets/landscape.webp" alt="San Francisco skyline and bridge in silver fog"></picture><div class="hero-copy"><h1><span>Your agent is already running.</span><br>That’s not the same as working</h1><p>neatlogs finds what’s failing, works out why, and hands you a fix.</p><div class="hero-actions"><button class="setup" data-unavailable><span class="setup-border" aria-hidden="true"><span class="setup-comet"></span></span><span class="agent-symbols" aria-hidden="true"><img src="/assets/claude-color.svg" alt="" title="Claude Code"><img src="/assets/codex-symbol.svg" alt="" title="Codex"><img src="/assets/cursor-symbol.svg" alt="" title="Cursor"></span><span class="setup-label">Copy setup prompt</span><svg class="setup-copy" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg></button>${link('/entry','Try with your project ↗','outline')}</div></div></main><footer class="landing-foot">Tailor proof of concept · limited Neatlogs replica · fictional projects only. ${link('/entry','Explore the deterministic demo')}</footer></div>`;
}
function entry() {
  document.documentElement.classList.remove('chat-dock', 'rail-open');
  const turns = draft;
  const started = turns.length > 0;
  root.innerHTML = `<div class="chat-home"><header class="entry-nav">${link('/','neatlogs','wordmark')}${link('/','← Back to landing')}</header><div class="chat-stage"><p class="chat-label">${ADAPTER_LABEL} — not an agent</p>${started?`<div class="chat-thread">${chatThread(turns)}</div>`:`<h1>hello</h1><p>What fictional failure should this demo explore?</p>`}${composer(chatBusy)}${examples()}${started?`<button type="button" data-discard-draft>Discard draft</button>`:`<button type="button" id="resume">Resume this browser’s saved session</button>`}<p class="form-error" role="alert"></p></div></div>`;
}
function list(s: DemoSession,data: TraceList) {
  lastList = data;
  const query = new URLSearchParams(location.search);
  const chip = (key: string) => query.get(key) ? `<button type="button" class="chip-remove" data-clear-filter="${key}" aria-label="Remove ${key} filter">×</button>` : '';
  const select = (key:string,label:string,options:string[][])=>`<details class="filter-popover${query.get(key)?' is-selected':''}"><summary>${label==='Fixture'?'Workflow':label}${query.get(key)?` · ${esc(options.find(([v])=>v===query.get(key))?.[1] ?? query.get(key))}`:''}${chip(key)}⌄</summary><div class="filter-editor"><label>${label==='Fixture'?'Synthetic fixture':label}<select name="${key}" aria-label="${label}"><option value="">All</option>${options.map(([v,l])=>`<option value="${v}" ${query.get(key)===v?'selected':''}>${l}</option>`).join('')}</select></label><button type="submit">Apply filters</button></div></details>`;
  const rows = data.traces.map(t=>{
    const when = ingested(t.ingestedAt);
    const found = t.spans.filter(span => span.detection).length;
    const active = t.scenario === data.activeScenario ? ' is-active-fixture' : '';
    return `<tr class="${active.trim()}" data-trace="${t.id}"><td><input type="checkbox" aria-label="Select ${t.scenario}" data-select></td><td class="mono">${link(traceLink(t),`<span>${esc(when.time)}</span> <small>${esc(when.date)}</small><span class="mobile-fixture">${t.scenario==='recovered'?'Retry recovers':'Both attempts fail'}</span>`)}</td><td><span class="ready" title="Ready means processed; task outcome is separate">${icon('check')}<span class="sr">Ready</span></span></td><td>${found?`<span class="failure">Execution Failed &nbsp; ${found}</span>`:'–'}</td><td>—</td><td>${link(traceLink(t),`Scenario: ${t.scenario} · Order lookup · Synthetic: true${t.scenario===data.activeScenario?' · Active fixture':''}`)}</td><td>${link(traceLink(t),io(t.output).replace(/<br>/g,' '))}</td><td>—</td><td><button data-unavailable aria-label="Replay is outside this demo">${icon('clock')}</button></td></tr>`;
  }).join('');
  const days = ['Sep 28','','Sep 30','','Oct 2','','','Oct 5','','Oct 7','','Oct 9','','Oct 11'];
  root.innerHTML = shell(s,`<header class="list-header"><h1>${icon('list')}Traces</h1><div class="header-controls"><button class="active">Traces</button><button data-unavailable>Sessions</button><button data-unavailable>Users</button><details class="search-popover" ${query.get('q')?'open':''}><summary aria-label="Search traces">${icon('search')}</summary><form id="search-form"><input name="q" aria-label="Search traces" placeholder="Search traces…" value="${esc(query.get('q') ?? '')}"></form></details><button data-unavailable>Last 14 days⌄</button><button data-refresh aria-label="Refresh traces">${icon('refresh')}</button></div></header><form id="filters" class="filters">${['Session ID','User ID'].map(n=>`<button type="button" data-unavailable class="filter">${n}⌄</button>`).join('')}${select('scenario','Fixture',[['recovered','Retry recovers'],['exhausted','Both attempts fail']])}${select('detection','Detections',[['yes','Execution Failed'],['no','No detections']])}<button type="button" data-unavailable class="filter">Evals⌄</button>${select('tag','Tags',[['synthetic','synthetic'],['recovered','recovered'],['exhausted','exhausted']])}<details class="filter-popover${query.get('minMs')?' is-selected':''}"><summary>Latency${query.get('minMs')?` ≥ ${esc(query.get('minMs'))}ms`:''}${chip('minMs')}⌄</summary><div class="filter-editor"><label>Minimum latency in milliseconds<input name="minMs" type="number" min="0" step="0.1" aria-label="Minimum latency in milliseconds" value="${esc(query.get('minMs') ?? '')}" placeholder="ms"></label><button type="submit">Apply filters</button></div></details><button type="button" data-unavailable class="filter">Metadata⌄</button><button type="button" data-unavailable class="filter">More filters⌄</button><button type="button" data-unavailable class="filter">＋ Advanced</button>${link(base(s.id),'Clear')}</form><div class="histogram" aria-label="${data.filtered} filtered traces on Oct 10">${days.map((label,i)=>{const count=i===12?data.filtered:0;return `<div class="day" style="--count:${count}" title="${count} traces">${count?`<i class="day-bar" style="--count:${count}"></i>`:''}<span>${label}</span></div>`;}).join('')}</div><div class="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select all traces" id="select-all"></th>${['Ingested at','Status','Detections','Evals','Input','Output','Comments','Replay'].map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty"><div class="empty-mark">${icon('doc')}</div><h2>No traces found</h2><p>Try adjusting your filters or date range.</p>${link(base(s.id),'Clear filters','empty-clear')}</td></tr>`}</tbody></table></div>${notice(s)}<footer class="pagination"><label>Rows per page <select aria-label="Rows per page"><option>25</option></select></label><span data-count>${data.filtered?`1 – ${data.filtered}`:'0'} of ${data.filtered}</span><button disabled aria-label="Previous page">‹</button><button class="active">1</button><button disabled aria-label="Next page">›</button></footer>`);
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
  root.innerHTML=shell(s,`<header class="detail-header">${link(back,icon('back'),'back-link')}<span>${esc(ingested(t.ingestedAt).heading)}</span><div><button data-unavailable aria-label="Search this trace">${icon('search')}</button><button data-unavailable aria-label="Replay unavailable">${icon('clock')}</button><button data-unavailable aria-label="Comments unavailable">${icon('message')}</button><button data-tags>${t.tags.length} tags</button><button data-unavailable>Ask neat AI</button></div></header><div class="trace-toolbar"><details class="trace-picker"><summary aria-label="Trace navigator">${icon('list')}<span>${esc(t.name)}</span><small>${t.spans.length}</small>${icon('chevron')}</summary><nav aria-label="Synthetic trace choices">${s.dataset.traces.map(x=>link(traceLink(x),`${x.scenario==='recovered'?'Retry recovers':'Both attempts fail'} · ${x.spans[0]!.durationMs}ms · ${x.spans.length} spans`,x.id===t.id?'active':'')).join('')}</nav></details><button data-graph aria-pressed="${graph}" aria-label="Toggle span tree">${icon('tree')}</button><button data-timeline aria-pressed="${timeline}" aria-label="Toggle timeline">${icon('list')}</button><span class="trace-identity">${esc(t.name)} · ${t.spans.length} spans</span></div><main class="trace-canvas ${timeline?'with-timeline':''}">${graph?`<div class="graph-tree" aria-label="Span parent tree"><div class="graph-nodes"><svg class="graph-connectors" viewBox="0 0 360 360" preserveAspectRatio="none" aria-hidden="true">${t.spans.slice(1).map((_,i)=>`<path d="M140 32 C175 32 175 ${32+i*64} 205 ${32+i*64}"/>`).join('')}</svg><strong class="${kindClass(t.spans[0]!.kind)}">${icon(kindMark(t.spans[0]!.kind))}${esc(t.spans[0]!.name)}</strong><div class="graph-children">${t.spans.slice(1).map(graphNode).join('')}</div></div></div>`:''}<section class="trace-flow"><div class="root-input"><label>INPUT</label><div class="input-bubble">${io(t.input)}</div></div><div class="steps"><header><span>${t.spans.length} STEPS · ${t.spans[0]!.durationMs/1000}S</span><button data-expand-all>EXPAND ALL</button></header>${t.spans.filter(x=>!x.parentId||!collapsedRoots.has(x.parentId)).map(x=>spanRow(t,x,selected)).join('')}</div><div class="root-output"><label>OUTPUT</label><p>${io(t.output)}</p></div></section></main>${timeline?`<section class="timeline" aria-label="Trace timeline"><header>TIMELINE · ${t.spans[0]!.durationMs} ms</header>${t.spans.map(x=>`<div class="timeline-row ${graphSelection===x.id?'graph-selected':''}"><a data-nav href="${path}?span=${x.id}">${esc(x.name)}</a><div class="time-track"><a data-nav aria-label="Select ${esc(x.name)} in timeline" href="${path}?span=${x.id}" class="time-bar ${x.status==='ERROR'?'bad':''}" style="left:${x.startMs/t.spans[0]!.durationMs*100}%;width:${Math.max(0.5,x.durationMs/t.spans[0]!.durationMs*100)}%"></a></div><time>${durationLabel(x.durationMs)}</time></div>`).join('')}</section>`:''}${notice(s)}`);
}
async function render() {
  const run = ++generation; controller?.abort(); controller = new AbortController();
  if (location.pathname==='/') { landing(); return; }
  if (location.pathname==='/entry') { entry(); return; }
  document.documentElement.classList.remove('chat-dock');
  root.innerHTML='<main class="loading" role="status">Loading synthetic traces…</main>';
  try {
    const route = /^\/demo\/([^/]+)\/traces(?:\/([^/]+))?$/.exec(location.pathname);
    if (!route) throw new Error('NOT_FOUND: Page not found.');
    const s = await request<DemoSession>(`/api/sessions/${route[1]}`);
    if (run!==generation) return; current=s; chatOpen = sessionStorage.getItem(chatKey(s.id)) !== '1';
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
    document.documentElement.classList.remove('chat-dock');
    root.innerHTML=`<main class="request-error"><h1>Demo unavailable</h1><p role="alert">${esc((e as Error).message)}</p><button data-refresh>Retry</button> ${link('/entry','Create a fictional session')}</main>`;
  }
}
function stamp(role: ChatTurn['role'], text: string, status: ChatTurn['status']): ChatTurn {
  return { id: crypto.randomUUID(), role, text, status, at: new Date().toISOString() };
}
function repaint() {
  if (!current || location.pathname === '/entry' || location.pathname === '/') { entry(); return; }
  const trace = current.dataset.traces.find(t => location.pathname.endsWith(`/${t.id}`));
  if (trace) detail(current, trace);
  else if (lastList) list(current, { ...lastList, version: current.version, activeScenario: current.dataset.activeScenario });
  else void render();
}
async function persist(turns: ChatTurn[]) {
  if (!current || location.pathname === '/entry') { saveDraft(turns); return null; }
  const saved = await request<DemoSession>(`/api/sessions/${current.id}/conversation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: turns }) }, true);
  current = saved;
  return saved;
}
async function createSession(description: string, scenario: Scenario, turns: ChatTurn[], buyerId: string) {
  const payload = JSON.stringify({ description, scenario, conversation: turns });
  let operation = sessionStorage.getItem('creation-operation');
  if (!operation || sessionStorage.getItem('creation-payload') !== payload) {
    operation = crypto.randomUUID();
    sessionStorage.setItem('creation-operation', operation);
    sessionStorage.setItem('creation-payload', payload);
  }
  const s = await request<DemoSession>('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation }, body: payload }, true);
  const applied = turns.map(turn => turn.id === buyerId ? { ...turn, status: 'applied' as const } : turn).concat(stamp('tailor', `${ADAPTER_LABEL}. The demo API saved the ${scenario} fixture. The trace list now shows it as the active fixture.`, 'note'));
  let next = s;
  try { next = await request<DemoSession>(`/api/sessions/${s.id}/conversation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: applied }) }, true); }
  catch { next = { ...s, conversation: applied }; }
  sessionStorage.removeItem('creation-operation');
  sessionStorage.removeItem('creation-payload');
  sessionStorage.removeItem('tailor-draft-chat');
  draft = [];
  current = next;
  chatOpen = true;
  sessionStorage.removeItem(chatKey(s.id));
  chatBusy = false;
  navigate(base(s.id));
}
async function sendChat(text: string) {
  const message = text.trim();
  if (!message || chatBusy) return;
  chatBusy = true;
  const onEntry = location.pathname === '/entry' || !current;
  const result = adapt({ text: message, hasSession: !onEntry, activeScenario: onEntry ? null : current!.dataset.activeScenario });
  const changing = result.action === 'create' || result.action === 'switch';
  const buyer = stamp('buyer', message, changing ? 'pending' : 'note');
  let turns = [...(onEntry ? draft : turnsOf(current)), buyer, stamp('tailor', result.text, 'note')];
  const show = () => { if (onEntry) { saveDraft(turns); entry(); } else if (current) { current = { ...current, conversation: turns }; repaint(); } };
  show();
  try {
    if (result.action === 'create' && result.scenario) { await createSession(result.description, result.scenario, turns, buyer.id); return; }
    if (result.action === 'switch' && current && result.scenario) {
      await persist(turns);
      const version = current.version;
      const saved = await request<DemoSession>(`/api/sessions/${current.id}/scenario`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, scenario: result.scenario }) }, true);
      const listed = await request<TraceList>(`/api/sessions/${current.id}/traces${location.pathname.includes('/traces/') ? '' : location.search}`, {}, true);
      if (saved.dataset.activeScenario !== result.scenario || listed.activeScenario !== result.scenario || listed.version !== saved.version) throw new Error('The traces on screen do not match the saved fixture.');
      current = saved;
      lastList = listed;
      turns = turns.map(turn => turn.id === buyer.id ? { ...turn, status: 'applied' as const } : turn).concat(stamp('tailor', `${ADAPTER_LABEL}. The demo API saved the ${result.scenario} fixture. The trace list now shows it as the active fixture.`, 'note'));
      try { await persist(turns); } catch { current = { ...saved, conversation: turns }; }
      chatBusy = false;
      if (location.pathname.startsWith('/demo/')) repaint();
      return;
    }
    await persist(turns);
    chatBusy = false;
    if (onEntry) entry(); else if (location.pathname.startsWith('/demo/')) repaint();
  } catch (e) {
    const reason = (e as Error).message.replace(/[.\s]+$/, '');
    turns = turns.map(turn => turn.id === buyer.id && changing ? { ...turn, status: 'failed' as const } : turn).concat(stamp('tailor', `${ADAPTER_LABEL}. ${reason}. The last working fixture is unchanged.`, 'note'));
    try { await persist(turns); } catch { if (onEntry) saveDraft(turns); else if (current) current = { ...current, conversation: turns }; }
    chatBusy = false;
    if (onEntry) entry(); else if (location.pathname.startsWith('/demo/')) repaint();
    document.querySelector('.form-error')?.replaceChildren(document.createTextNode((e as Error).message));
  }
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
  if (el.hasAttribute('data-discard-draft')) { saveDraft([]); chatBusy = false; entry(); return; }
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
  if (el.id==='resume') { try {const s=await request<DemoSession>('/api/session');navigate(base(s.id));} catch(e){toast((e as Error).message);} return; }
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
document.addEventListener('change',event=>{
  const el=event.target as HTMLInputElement;
  if(el.id==='trace-navigator' && current)navigate(`${base(current.id)}/${el.value}`);
  if(el.id==='select-all')document.querySelectorAll<HTMLInputElement>('[data-select]').forEach(x=>x.checked=el.checked);
});
window.addEventListener('popstate',()=>void render());
if (!history.state || typeof (history.state as {tailor?: unknown}).tailor !== 'number') history.replaceState({ tailor: 0 }, '');
void render();
