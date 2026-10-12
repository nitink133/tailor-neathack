// Explanatory choreography only: no requests, buyer-state access, or runtime instrumentation.
export const MOTION_STEPS = [
  ['Stay in scope', '“Show me delivery-support retries.”', 'Scope guard · Sonnet 5.5 / low', 'Scope checked'],
  ['Select what matters', 'Relevant context joins. Older turns stay outside this packet.', 'Keyword-ranked capabilities · up to six records', 'Context selected'],
  ['Carry this session', 'The working story, active demo and versions travel together.', 'Session state · not a permanent buyer profile', 'Session context loaded'],
  ['Choose a bounded action', 'Adapt a fictional retry example.', 'Sonnet 5.5 · planner / explain: medium', 'Model usage recorded'],
  ['Use a permitted tool', 'A declared tool acts inside the Neatlogs adapter.', 'Product schemas · bounded calls · permitted actions', 'Tool outcome recorded'],
  ['Verify the saved result', 'Validate → save v4 → independently read v4.', 'Conflict or uncertain readback cannot become success.', 'Validation / save / readback'],
  ['Answer, then guide', '“Your retry example is ready.”', 'Guided target checked against saved demo v4', 'Answer / guidance checked'],
  ['A session has an end', 'Time jump · End demo or expiry clears conversation and demo data.', '1 hour idle / 4 hours maximum · closing a tab is not End demo', 'Hosted telemetry has separate retention'],
];
const STEP_MS = 3000;
export const MOTION_DURATION_MS = 24000;
const positions = [70, 220, 370, 520, 660, 750, 940, 940];
const ease = n => n * n * (3 - 2 * n);
export function renderMotion() {
  return `<section class="agent-motion container" aria-labelledby="motion-title" data-agent-motion>
    <div class="motion-heading"><div><p class="eyebrow">Inside the agent</p><h2 id="motion-title">One question. A moving packet.</h2></div><p class="motion-disclaimer">Explanatory animation<br> Fictional example · not live execution</p></div>
    <div class="motion-stage" data-step="0">
      <div class="motion-caption"><span data-motion-number>01 / 08</span><h3 data-motion-title>${MOTION_STEPS[0][0]}</h3><p data-motion-note>${MOTION_STEPS[0][1]}</p></div>
      <svg class="motion-canvas" viewBox="0 0 1120 340" aria-hidden="true" focusable="false">
        <defs><mask id="packet-hole"><rect width="150" height="176" fill="white"/><circle cx="75" cy="94" r="28" fill="black"/></mask></defs>
        <path class="motion-track" d="M80 227 H1040"/>
        <g class="motion-landmarks"><text x="90" y="265">Scope</text><text x="340" y="265">Context</text><text x="665" y="265">Action</text><text x="958" y="265">Demo</text></g>
        <g class="scope-gate"><path d="M145 30v171m0-137h65m-65 108h65"/><path class="scope-check" d="M170 111l10 10 22-25"/></g>
        <g class="context-sheets">${['Capabilities','Active trace','Relevant turns'].map((label,i)=>`<g data-context-sheet><rect x="247" y="${22+i*54}" width="136" height="42"/><text x="259" y="${49+i*54}">${label}</text></g>`).join('')}</g>
        <g class="old-context" data-old-context><rect x="415" y="140" width="140" height="44"/><text x="428" y="168">Older turns</text></g>
        <g class="model-station"><text x="500" y="42">Sonnet 5.5</text><text x="500" y="68">low → medium</text></g>
        <g class="tool-station"><path d="M708 43h78v155h-78m78-111h-31m31 69h-31"/><text x="671" y="22">Adapter</text></g>
        <g class="verification"><circle cx="885" cy="104" r="37"/><path class="readback-check" d="M866 106l13 13 25-29"/><text x="830" y="169" data-verify-label>Validate</text></g>
        <g class="demo-station"><rect x="968" y="44" width="122" height="154"/><path d="M985 79h87m-87 28h59m-59 28h76m-76 28h44"/></g>
        <g data-packet class="moving-packet" transform="translate(70 46)"><path class="packet-back" d="M16-16h120l22 22v160H16z"/><path class="packet-mid" d="M8-8h120l22 22v160H8z"/><g mask="url(#packet-hole)"><path class="packet-front" d="M0 0h120l22 22v152H0z"/><path class="packet-fold" d="M120 0v22h22"/></g><text x="17" y="36" class="packet-label" data-packet-label>QUESTION</text></g>
        <g class="motion-guidance"><rect x="780" y="285" width="308" height="43"/><text x="800" y="313">Explore retry trace →</text></g>
      </svg>
      <p class="motion-detail" data-motion-detail>${MOTION_STEPS[0][2]}</p>
      <div class="session-tray"><span>THIS SESSION</span><div class="session-content"><p>Buyer said: delivery support</p><p>Tailor assumes: fictional retry example</p><p data-demo-version>Demo v3 · current trace</p></div><p class="session-ended" hidden>Demo conversation + data cleared<br>Content-free tombstone remains briefly</p><span data-session-state>Active</span></div>
      <div class="telemetry-rail"><span class="telemetry-dot" aria-hidden="true"></span><span>Runtime instrumentation</span><p data-motion-event>${MOTION_STEPS[0][3]}</p><span>Separate retention</span></div>
    </div>
    <div class="motion-controls" role="group" aria-label="Animation playback"><button type="button" data-motion-play aria-label="Play animation">Play</button><button type="button" data-motion-replay>Replay</button><button type="button" data-motion-prev aria-label="Previous animation step" disabled>← Previous</button><button type="button" data-motion-next aria-label="Next animation step">Next →</button><span data-motion-playback>Ready · 24 seconds</span></div>
    <ol class="motion-step-list" aria-label="Animation steps">${MOTION_STEPS.map((step,i)=>`<li><button type="button" data-motion-step="${i}" ${i===0?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span>${step[0]}</button></li>`).join('')}</ol>
    <p class="motion-access-note">Pause anywhere to explain a step. The last scene is an illustrative time jump; hosted telemetry does not clear with the demo.</p>
    <p class="motion-sr-only" role="status" aria-live="polite" aria-atomic="true" data-motion-status></p>
  </section>`;
}
export function attachMotion(root = document) {
  root.querySelectorAll('[data-agent-motion]').forEach(section => {
    if (section.dataset.bound) return;
    section.dataset.bound = 'true';
    const get = name => section.querySelector(`[data-motion-${name}]`);
    const stage = section.querySelector('.motion-stage');
    const packet = section.querySelector('[data-packet]');
    const old = section.querySelector('[data-old-context]');
    const sheets = [...section.querySelectorAll('[data-context-sheet]')];
    const buttons = [...section.querySelectorAll('[data-motion-step]')];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let elapsed = 0, playing = false, frame = 0, last = 0, current = -1;
    function draw() {
      const index = Math.min(7, Math.floor(elapsed / STEP_MS));
      const within = elapsed - index * STEP_MS;
      const fraction = ease(Math.min(1, within / 700));
      const x = positions[Math.max(0,index-1)] + (positions[index]-positions[Math.max(0,index-1)]) * fraction;
      const float = reduced.matches ? 0 : Math.sin(elapsed/420)*5;
      const rotate = reduced.matches ? 0 : Math.sin(fraction*Math.PI)*-5;
      const targetScale = index===4 || index===5 ? .65 : 1;
      const previousScale = index===5 || index===6 ? .65 : 1;
      const scale = previousScale + (targetScale-previousScale)*fraction;
      packet.setAttribute('transform', `translate(${x} ${46+float}) rotate(${rotate} 75 90) scale(${scale})`);
      packet.setAttribute('opacity', String(index===7 ? 1-ease(Math.min(1,within/1100)) : 1));
      old.setAttribute('transform', `translate(0 ${index>=1?ease(Math.min(1,(elapsed-3000)/900))*64:0})`);
      sheets.forEach((sheet,i)=>{ const n=index===1?ease(Math.max(0,Math.min(1,(within-i*100)/650))):index>1?1:0; sheet.setAttribute('transform',`translate(${n*100} ${n*(40-i*30)})`); sheet.setAttribute('opacity',String(1-n*.65)); });
      // Verification is sequenced, not a success badge that appears before save/readback.
      const verified=index>5 || (index===5 && within>=1800);
      stage.dataset.verified=String(verified);
      section.querySelector('[data-verify-label]').textContent=index===5?(within<800?'Validate':within<1800?'Save v4':'Read v4'):'Readback';
      section.querySelector('[data-demo-version]').textContent=verified?'Demo v4 · readback matched':'Demo v3 · current trace';
      if(index!==current) {
        current=index; const step=MOTION_STEPS[index]; stage.dataset.step=String(index); section.dataset.step=String(index);
        get('number').textContent=`${String(index+1).padStart(2,'0')} / 08`;
        ['title','note','detail','event'].forEach((key,i)=>get(key).textContent=step[i]);
        get('status').textContent=`Step ${index+1} of 8. ${step[0]}. ${step[1]} ${step[2]}`;
        section.querySelector('[data-packet-label]').textContent=['QUESTION','CONTEXT','SESSION','PLAN','ACTION','SAVE / READ','VERIFIED',''][index];
        section.querySelector('[data-session-state]').textContent=index===7?'Ended':'Active';
        section.querySelector('.session-content').hidden=index===7; section.querySelector('.session-ended').hidden=index!==7;
        buttons.forEach((button,i)=>i===index?button.setAttribute('aria-current','step'):button.removeAttribute('aria-current'));
        get('prev').disabled=index===0; get('next').disabled=index===7;
      }
      get('play').textContent=reduced.matches?'Step →':playing?'Pause':'Play';
      get('play').setAttribute('aria-label',reduced.matches?'Advance animation one step':playing?'Pause animation':'Play animation');
      get('play').disabled=reduced.matches&&index===7;
      get('playback').textContent=reduced.matches?'Reduced motion · step through':playing?'Playing · illustrative sequence':elapsed>=MOTION_DURATION_MS?'Complete':elapsed===0?'Ready · 24 seconds':'Paused';
      section.dataset.playing=String(playing);
    }
    function stop(){playing=false;cancelAnimationFrame(frame);}
    function tick(now){if(!playing)return;elapsed=Math.min(MOTION_DURATION_MS,elapsed+now-last);last=now;if(elapsed>=MOTION_DURATION_MS)stop();draw();if(playing)frame=requestAnimationFrame(tick);}
    function play(){if(reduced.matches){go(current+1);return;}if(elapsed>=MOTION_DURATION_MS)elapsed=0;playing=true;last=performance.now();draw();frame=requestAnimationFrame(tick);}
    function go(index){stop();index=Math.max(0,Math.min(7,index));elapsed=index*STEP_MS+2000;draw();}
    get('play').addEventListener('click',()=>{if(playing){stop();draw();}else play();});
    get('replay').addEventListener('click',()=>{stop();elapsed=0;current=-1;reduced.matches?draw():play();});
    get('prev').addEventListener('click',()=>go(current-1));get('next').addEventListener('click',()=>go(current+1));
    buttons.forEach((button,i)=>button.addEventListener('click',()=>go(i)));
    section.addEventListener('keydown',event=>{if(!event.target.closest('.motion-controls,.motion-step-list'))return;if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)){event.preventDefault();go(event.key==='Home'?0:event.key==='End'?7:current+(event.key==='ArrowRight'?1:-1));}});
    reduced.addEventListener('change',()=>{stop();go(Math.max(0,current));});
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){stop();draw();}});
    draw();
  });
}
