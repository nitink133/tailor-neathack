import type { DemoSession, Json, Span, Trace, TraceList } from './contracts.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icon = (name: string) => {
  const paths: Record<string,string> = { list:'M5 4v16h15M9 7h10M9 11h10M9 15h10', search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', back:'M20 12H4m6-6-6 6 6 6', refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5', tool:'M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-4 3-3-3z', tree:'M8 4v16m0-12h8m-8 8h8M5 2h6v4H5zM16 6h5v4h-5zM16 14h5v4h-5z', clock:'M12 7v5l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', check:'M7 12l3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', close:'M6 6l12 12M18 6 6 18', chevron:'m8 5 7 7-7 7', sun:'M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', home:'M3 10l9-7 9 7v10H3z', message:'M4 4h16v13H9l-5 4z', bell:'M5 17h14l-2-5V8a5 5 0 0 0-10 0v4zM10 21h4' };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] ?? paths.list}"/></svg>`;
};
let current: DemoSession | undefined;
let generation = 0;
let controller: AbortController | undefined;
let timeline = false;
let graph = false;
const expanded = new Set<string>();
let returnTo = '';
const link = (path: string,label: string,cls='')=>`<a data-nav href="${esc(path)}" class="${cls}">${label}</a>`;
const base = (id: string) => `/demo/${id}/traces`;
const traceLink = (t: Trace) => `${base(t.sessionId)}/${t.id}`;
function navigate(path: string) { history.pushState(null,'',path); void render(); }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path,{...init,signal:controller?.signal});
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error?.code ?? response.status}: ${data.error?.message ?? 'Request failed.'}`);
  return data as T;
}
const io = (value: Json) => value && typeof value==='object' && !Array.isArray(value)
  ? Object.entries(value).map(([k,v])=>`${esc(k)}: ${esc(typeof v==='object' ? JSON.stringify(v) : v)}`).join('<br>') : esc(JSON.stringify(value));
function shell(s: DemoSession,content: string) {
  return `<aside class="rail"><a data-nav href="/" class="mark" aria-label="Landing page">n</a>${['message','tree','home','tool','list','search','bell'].map((n,i)=>i===4?link(base(s.id),icon(n),'rail-button selected'):`<button class="rail-button" data-unavailable aria-label="${n} — outside this demo">${icon(n)}</button>`).join('')}<div class="rail-bottom"><button data-theme aria-label="Toggle local theme">${icon('sun')}</button></div></aside><div class="workspace"><div class="demo-notice">Synthetic local demo · two deterministic fixtures · text is saved, not personalized <span>v${s.version} · active fixture: ${s.dataset.activeScenario}</span></div>${content}</div>`;
}
function landing() {
  root.innerHTML = `<div class="landing"><div class="hack">Oct 10–12 &nbsp; Join neatHack · $19,000 in prizes & credits ↗</div><header class="public-nav">${link('/','neatlogs','wordmark')}<nav>${['Manifesto','Product','Pricing','Docs','Blog','Changelog','Careers'].map(n=>`<button data-unavailable>${n}</button>`).join('')}${link('/entry','Try with your project ↗','solid')}</nav></header><main class="hero"><picture><source media="(max-width:600px)" srcset="/assets/portrait.webp"><img src="/assets/landscape.webp" alt="San Francisco skyline and bridge in silver fog"></picture><div class="hero-copy"><h1><span>Your agent is already running.</span><br>That’s not the same as working</h1><p>neatlogs finds what’s failing, works out why, and hands you a fix.</p><div class="hero-actions"><button class="setup" data-unavailable>Copy setup prompt</button>${link('/entry','Try with your project ↗','outline')}</div></div></main><footer class="landing-foot">Tailor proof of concept · limited Neatlogs replica · fictional projects only. ${link('/entry','Explore the deterministic demo')}</footer></div>`;
}
function entry() {
  root.innerHTML = `<header class="entry-nav">${link('/','neatlogs','wordmark')}${link('/','← Back to landing')}</header><main class="entry"><h1>Try with your project</h1><p>Describe a fictional existing or planned project, then explore two synthetic order lookup traces.</p><p class="entry-note">Your text is saved for local vendor review. It does not generate personalization. There is no LLM or agent in this demo.</p><form id="entry-form"><label for="description">Fictional project description</label><textarea id="description" name="description" maxlength="4000" required rows="5" placeholder="A fictional order support agent for a small online shop…"></textarea><fieldset><legend>Initial fixture</legend><label><input type="radio" name="scenario" value="recovered" checked> First attempt fails, retry recovers</label><label><input type="radio" name="scenario" value="exhausted"> Both attempts fail, safely escalate</label></fieldset><button class="solid" type="submit">Save and explore traces ${icon('chevron')}</button><p class="form-error" role="alert"></p></form><p class="privacy">Local fictional sessions only. Saved on this Mac until manually reset; no public sharing. ${link('/entry','Start another fictional session')}</p><button id="resume">Resume this browser’s saved session</button></main>`;
}
function list(s: DemoSession,data: TraceList) {
  const query = new URLSearchParams(location.search);
  const select = (key:string,label:string,options:string[][])=>`<label class="filter">${label}<select name="${key}" aria-label="${label}"><option value="">All</option>${options.map(([v,l])=>`<option value="${v}" ${query.get(key)===v?'selected':''}>${l}</option>`).join('')}</select></label>`;
  const rows = data.traces.map(t=>`<tr data-trace="${t.id}"><td><input type="checkbox" aria-label="Select ${t.scenario}" data-select></td><td class="mono">${link(traceLink(t),`<span>11:47 PM</span> <small>Oct 10</small><span class="mobile-fixture">${t.scenario==='recovered'?'Retry recovers':'Both attempts fail'}</span>`)}</td><td><span class="ready" title="Ready means processed; task outcome is separate">${icon('check')}<span class="sr">Ready</span></span></td><td>${t.spans.some(s=>s.detection)?`<span class="failure">Execution Failed &nbsp; 2</span>`:'–'}</td><td>—</td><td>${link(traceLink(t),`Scenario: ${t.scenario} · Order lookup · Synthetic: true`)}</td><td>${link(traceLink(t),esc(JSON.stringify(t.output)))}</td><td>—</td><td><button data-unavailable aria-label="Replay is outside this demo">${icon('clock')}</button></td></tr>`).join('');
  root.innerHTML = shell(s,`<header class="list-header"><h1>${icon('list')}Traces</h1><div class="header-controls"><button class="active">Traces</button><button data-unavailable>Sessions</button><button data-unavailable>Users</button><form id="search-form">${icon('search')}<input name="q" aria-label="Search traces" placeholder="Search traces…" value="${esc(query.get('q') ?? '')}"></form><button data-unavailable>Last 14 days⌄</button><button data-refresh aria-label="Refresh traces">${icon('refresh')}</button></div></header><form id="filters" class="filters">${select('scenario','Fixture',[['recovered','Retry recovers'],['exhausted','Both attempts fail']])}${select('detection','Detections',[['yes','Execution Failed'],['no','No detections']])}${select('tag','Tags',[['synthetic','synthetic'],['recovered','recovered'],['exhausted','exhausted']])}<label class="filter">Latency ≥<input name="minMs" type="number" min="0" step="0.1" aria-label="Minimum latency in milliseconds" value="${esc(query.get('minMs') ?? '')}" placeholder="ms"></label><button type="submit">Apply</button>${link(base(s.id),'Clear')}</form><div class="histogram" aria-label="${data.filtered} filtered traces on Oct 10">${Array.from({length:14},(_,i)=>`<div class="day ${i===12&&data.filtered?'populated':''}" title="${i===12?data.filtered:0} traces"><span>${['Sep 28','','Sep 30','','Oct 2','','','Oct 5','','Oct 7','','Oct 9','','Oct 11'][i]}</span></div>`).join('')}</div><div class="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Select all traces" id="select-all"></th>${['Ingested at','Status','Detections','Evals','Input','Output','Comments','Replay'].map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty"><h2>No traces found</h2><p>Try adjusting your filters or date range.</p>${link(base(s.id),'Clear filters')}</td></tr>`}</tbody></table></div><footer class="pagination"><label>Rows per page <select aria-label="Rows per page"><option>25</option></select></label><span data-count>${data.filtered?`1 – ${data.filtered}`:'0'} of ${data.filtered}</span><button disabled aria-label="Previous page">‹</button><button class="active">1</button><button disabled aria-label="Next page">›</button></footer>`);
}
function spanRow(t:Trace,s:Span,selected:string|null):string {
  const open = expanded.has(s.id) || s.id===selected;
  return `<div class="span-row ${s.parentId?'child':''} ${s.id===selected?'selected-span':''}" data-span-id="${s.id}" style="--depth:${s.parentId?1:0}"><button class="span-head" data-expand="${s.id}" aria-expanded="${open}">${icon('chevron')}${icon(s.status==='ERROR'?'close':s.kind==='TOOL'?'tool':'tree')}<span>${esc(s.name)}</span><small>${s.kind}</small>${s.status==='ERROR'?'<b class="error-text">ERROR</b>':''}<time>${s.durationMs<1?`${s.durationMs*1000}µs`:`${s.durationMs}ms`}</time></button>${s.detection?'<span class="span-detection failure">Execution Failed</span>':''}${open?`<div class="span-content"><div class="span-actions">${link(`${traceLink(t)}?span=${s.id}`,'Link to span')}<button data-copy="${s.id}">Copy span JSON</button></div><label>INPUT</label><pre>${esc(JSON.stringify(s.input,null,2))}</pre>${s.error?`<label class="error-text">ERROR</label><pre class="error-box">${esc(s.error)}</pre>`:`<label>OUTPUT</label><pre>${esc(JSON.stringify(s.output,null,2))}</pre>`}<dl><dt>Start offset</dt><dd>${s.startMs} ms</dd><dt>Duration</dt><dd>${s.durationMs} ms</dd><dt>Span ID</dt><dd>${s.id}</dd><dt>Parent ID</dt><dd>${s.parentId ?? 'Root'}</dd></dl></div>`:''}</div>`;
}
function detail(s:DemoSession,t:Trace) {
  const selected = new URLSearchParams(location.search).get('span');
  if (selected && !t.spans.some(x=>x.id===selected)) throw new Error('NOT_FOUND: Span not found in this trace.');
  const path = traceLink(t);
  const back = returnTo.startsWith(base(s.id)) && !returnTo.slice(base(s.id).length).startsWith('/') ? returnTo : base(s.id);
  root.innerHTML=shell(s,`<header class="detail-header">${link(back,icon('back'),'back-link')}<span>10th Oct, 11:47 PM</span><div><button data-unavailable aria-label="Search this trace">${icon('search')}</button><button data-unavailable aria-label="Replay unavailable">${icon('clock')}</button><button data-unavailable aria-label="Comments unavailable">${icon('message')}</button><button data-tags>${t.tags.length} tags</button><button data-unavailable>Ask neat AI</button></div></header><div class="trace-toolbar"><select aria-label="Trace navigator" id="trace-navigator">${s.dataset.traces.map(x=>`<option value="${x.id}" ${x.id===t.id?'selected':''}>${x.scenario} · ${x.spans[0]!.durationMs}ms · ${x.spans.length} spans</option>`).join('')}</select><button data-graph aria-pressed="${graph}" aria-label="Toggle span tree">${icon('tree')}</button><button data-timeline aria-pressed="${timeline}" aria-label="Toggle timeline">${icon('list')}</button><span class="trace-identity">${esc(t.name)} · ${t.spans.length} spans</span></div><main class="trace-canvas ${timeline?'with-timeline':''}">${graph?`<div class="graph-tree" aria-label="Span parent tree"><strong>${esc(t.spans[0]!.name)}</strong>${t.spans.slice(1).map(x=>link(`${path}?span=${x.id}`,`${icon(x.status==='ERROR'?'close':'tree')}${esc(x.name)}`)).join('')}</div>`:''}<section class="trace-flow"><div class="root-input"><label>INPUT</label><div class="input-bubble">${io(t.input)}</div></div><div class="steps"><header><span>${t.spans.length} STEPS · ${t.spans[0]!.durationMs/1000}S</span><button data-expand-all>EXPAND ALL</button></header>${t.spans.map(x=>spanRow(t,x,selected)).join('')}</div><div class="root-output"><label>OUTPUT</label><p>${io(t.output)}</p></div></section></main>${timeline?`<section class="timeline" aria-label="Trace timeline"><header>TIMELINE · ${t.spans[0]!.durationMs} ms</header>${t.spans.map(x=>`<div class="timeline-row"><a data-nav href="${path}?span=${x.id}">${esc(x.name)}</a><div class="time-track"><a data-nav aria-label="Select ${esc(x.name)} in timeline" href="${path}?span=${x.id}" class="time-bar ${x.status==='ERROR'?'bad':''}" style="left:${x.startMs/t.spans[0]!.durationMs*100}%;width:${Math.max(0.5,x.durationMs/t.spans[0]!.durationMs*100)}%"></a></div><time>${x.durationMs} ms</time></div>`).join('')}</section>`:''}`);
}
async function render() {
  const run = ++generation; controller?.abort(); controller = new AbortController();
  if (location.pathname==='/') { landing(); return; }
  if (location.pathname==='/entry') { entry(); return; }
  root.innerHTML='<main class="loading" role="status">Loading synthetic traces…</main>';
  try {
    const route = /^\/demo\/([^/]+)\/traces(?:\/([^/]+))?$/.exec(location.pathname);
    if (!route) throw new Error('NOT_FOUND: Page not found.');
    const s = await request<DemoSession>(`/api/sessions/${route[1]}`);
    if (run!==generation) return; current=s;
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
    root.innerHTML=`<main class="request-error"><h1>Demo unavailable</h1><p role="alert">${esc((e as Error).message)}</p><button data-refresh>Retry</button> ${link('/entry','Create a fictional session')}</main>`;
  }
}
document.addEventListener('click',async event=>{
  const el=(event.target as Element).closest<HTMLElement>('a,button'); if (!el) return;
  if (el.matches('a[data-nav]') && !(event as MouseEvent).metaKey && !(event as MouseEvent).ctrlKey) {
    event.preventDefault(); if (!location.pathname.match(/\/traces\//)) returnTo=location.pathname+location.search;
    navigate((el as HTMLAnchorElement).getAttribute('href')!); return;
  }
  if (el.hasAttribute('data-refresh')) { void render(); return; }
  if (el.hasAttribute('data-unavailable')) { toast('Outside this limited demo. No action was performed.'); return; }
  if (el.hasAttribute('data-theme')) { document.documentElement.classList.toggle('dark'); return; }
  if (el.id==='resume') { try {const s=await request<DemoSession>('/api/session');navigate(base(s.id));} catch(e){toast((e as Error).message);} return; }
  if (!current) return;
  const t=current.dataset.traces.find(t=>location.pathname.endsWith(t.id));
  if (el.hasAttribute('data-timeline')) {timeline=!timeline; if(t) detail(current,t);}
  if (el.hasAttribute('data-graph')) {graph=!graph; if(t) detail(current,t);}
  if (el.hasAttribute('data-expand')) { const id=el.dataset.expand!; expanded.has(id)?expanded.delete(id):expanded.add(id); if(t)detail(current,t); }
  if (el.hasAttribute('data-expand-all') && t) {t.spans.forEach(x=>expanded.add(x.id));detail(current,t);}
  if (el.hasAttribute('data-tags') && t) toast(t.tags.join(' · '));
  if (el.hasAttribute('data-copy') && t) {try {await navigator.clipboard.writeText(JSON.stringify(t.spans.find(s=>s.id===el.dataset.copy),null,2));toast('Span JSON copied.');}catch {toast('Clipboard unavailable; use the visible span JSON.');}}
});
function toast(message:string) { document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=message;root.append(el);setTimeout(()=>el.remove(),4500); }
document.addEventListener('submit',async event=>{
  const form=event.target as HTMLFormElement; event.preventDefault();
  if (form.id==='entry-form') {
    const button=form.querySelector<HTMLButtonElement>('button[type=submit]')!;if(button.disabled)return;button.disabled=true;button.textContent='Saving fictional session…';
    const fields=new FormData(form);
    const payload=JSON.stringify({description:fields.get('description'),scenario:fields.get('scenario')});
    let operation=sessionStorage.getItem('creation-operation');if(!operation || sessionStorage.getItem('creation-payload')!==payload){operation=crypto.randomUUID();sessionStorage.setItem('creation-operation',operation);sessionStorage.setItem('creation-payload',payload);}
    try {
      const s=await request<DemoSession>('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':operation},body:payload});
      sessionStorage.removeItem('creation-operation');sessionStorage.removeItem('creation-payload');navigate(base(s.id));
    }catch(e){form.querySelector('.form-error')!.textContent=(e as Error).message;button.disabled=false;button.textContent='Save and explore traces';}
  } else if (current && (form.id==='filters'||form.id==='search-form')) {
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
void render();
