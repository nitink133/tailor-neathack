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
const ease = n => n * n * (3 - 2 * n);
export function renderMotion() {
  return `<section class="agent-motion container" aria-labelledby="motion-title" data-agent-motion>
    <div class="motion-heading"><p class="eyebrow">Inside Tailor / An illustrated sequence</p><h2 id="motion-title">A question becomes<br>a demo of your own.</h2></div>
    <div class="motion-stage" data-step="0">
      <div class="motion-story"><span class="motion-chapter" data-motion-number>01 / 08</span><h3 data-motion-title>${MOTION_STEPS[0][0]}</h3><p class="motion-note" data-motion-note>${MOTION_STEPS[0][1]}</p><p class="motion-detail" data-motion-detail>${MOTION_STEPS[0][2]}</p><div class="motion-controls" role="group" aria-label="Animation playback"><button type="button" data-motion-play aria-label="Play animation">Play</button><button type="button" data-motion-replay aria-label="Replay animation">Replay</button><div class="motion-narration"><button type="button" data-motion-prev aria-label="Previous animation step" disabled>←</button><button type="button" data-motion-next aria-label="Next animation step">→</button></div></div><span class="motion-playback" data-motion-playback>Ready · 24 seconds</span></div>
      <div class="motion-art"><svg class="motion-canvas" viewBox="0 0 800 600" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="folio-front" x1="0" x2="1" y1="0" y2=".8"><stop stop-color="#4775ed"/><stop offset=".46" stop-color="#2449c9"/><stop offset="1" stop-color="#0d287f"/></linearGradient>
          <linearGradient id="folio-back" x1="0" x2="1"><stop stop-color="#1d3da9"/><stop offset=".65" stop-color="#3964db"/><stop offset="1" stop-color="#15358e"/></linearGradient>
          <linearGradient id="folio-edge" x1="0" x2="1"><stop stop-color="#7394ee"/><stop offset="1" stop-color="#2449c9"/></linearGradient>
          <mask id="folio-hole"><rect x="-240" y="-260" width="520" height="550" fill="white"/><ellipse cx="0" cy="0" rx="57" ry="68" fill="black" data-folio-hole/></mask>
        </defs>
        <ellipse class="folio-shadow" cx="440" cy="502" rx="150" ry="17"/>
        <g class="memory-orbit" opacity="0" data-memory-orbit><path d="M160 404C75 274 144 105 309 84C471 62 645 195 663 336"/><circle cx="160" cy="404" r="4"/><circle cx="663" cy="336" r="4"/></g>
        <g class="retained-leaf" data-old-context transform="translate(174 388)"><path d="M0-49Q40-38 72-57L68 43Q31 59-5 36Z"/><path d="M12-24L50-25M12-10L42-12"/></g>
        <g data-packet class="folio" transform="translate(433 286)">
          <g data-context-sheet class="folio-leaf folio-leaf-back"><path data-leaf-shape d="M-137-160Q-8-143 125-186L137 150Q11 186-125 151Z"/></g>
          <g data-context-sheet class="folio-leaf folio-leaf-middle"><path data-leaf-shape d="M-137-160Q-8-143 125-186L137 150Q11 186-125 151Z"/></g>
          <g data-context-sheet class="folio-leaf folio-leaf-front"><path data-leaf-shape mask="url(#folio-hole)" d="M-137-160Q-8-143 125-186L137 150Q11 186-125 151Z"/><path class="folio-highlight" d="M-137-160Q-8-143 125-186"/><ellipse class="folio-rim" cx="0" cy="0" rx="57" ry="68"/></g>
          <g class="folio-result" data-folio-result><path class="readback-check" d="M-30 0l21 23 42-48"/><path class="result-lines" d="M-75 97h150M-75 116h92"/></g>
        </g>
        <g class="action-ribbon" opacity="0" data-action-ribbon><path d="M177 395C251 492 574 465 647 296"/><circle cx="647" cy="296" r="5"/></g>
        <g class="motion-guidance"><text x="443" y="557" text-anchor="middle">Explore the retry trace →</text></g>
        <text class="art-aside" x="443" y="532" text-anchor="middle" data-art-aside>One question</text>
      </svg></div>
    </div>
    <div class="motion-bottom"><ol class="motion-step-list" aria-label="Animation steps">${MOTION_STEPS.map((step,i)=>`<li><button type="button" aria-label="${i+1}. ${step[0]}" data-motion-step="${i}" ${i===0?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span><span class="step-name">${step[0]}</span></button></li>`).join('')}</ol><p>Fictional illustration · not live execution</p></div>
    <div class="motion-footnotes"><div class="session-tray"><span class="footnote-label">Session memory</span><div class="session-content"><p data-demo-version>Demo v3 · current trace</p></div><p class="session-ended" hidden>Demo conversation + data cleared</p><span class="session-state" data-session-state>Active</span></div><div class="telemetry-rail"><span class="footnote-label">Instrumentation</span><p data-motion-event>${MOTION_STEPS[0][3]}</p><span>Separate retention</span></div></div>
    <details class="motion-facts"><summary>What travels with the question <span aria-hidden="true">+</span></summary><div><p>Buyer’s words and Tailor’s assumptions stay separate. Relevant turns, the working story, the active trace and versions form a bounded context. Pruning this packet does not erase the session.</p><p>Current model: Sonnet 5.5. Guard: low effort. Planner and explanation: medium. Declared tools are validated in code; a versioned save is independently read back before a verified answer.</p><p>End demo or expiry clears demo conversation and data. One hour idle / four hours maximum, with periodic cleanup and a brief content-free tombstone. Closing a tab is not End demo. Hosted telemetry has separate retention; no hosted deletion duration is claimed.</p></div></details>
    <p class="motion-access-note">Pause to narrate. The final scene is an illustrative time jump.</p><p class="motion-sr-only" role="status" aria-live="polite" aria-atomic="true" data-motion-status></p>
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
      const interpolate=(values)=>values[Math.max(0,index-1)]+(values[index]-values[Math.max(0,index-1)])*fraction;
      const fan=interpolate([.15,1,.35,.48,.04,.08,.7,.7]);
      const fold=interpolate([0,0,0,.12,.65,.32,0,0]);
      const tilt=interpolate([-10,-6,3,-4,-17,-6,4,4]);
      const float=reduced.matches?0:Math.sin(elapsed/1000)*3;
      packet.setAttribute('transform',`translate(${433+interpolate([0,0,0,0,20,12,0,0])} ${286+float}) rotate(${tilt})`);
      packet.setAttribute('opacity',String(index===7?1-ease(Math.min(1,within/1100)):1));
      sheets.forEach((sheet,i)=>{
        const depth=2-i;
        const dx=depth*(19+fan*38),dy=depth*(-13-fan*16);
        const rotation=depth*(3+fan*9);
        sheet.setAttribute('transform',`translate(${dx} ${dy}) rotate(${rotation}) scale(${1-fold*.28} 1)`);
        const shape=`M${-137+fold*75} -160Q${-8+fold*10} ${-143+fan*18} 125 ${-186+fold*38}L${137-fold*35} 150Q11 ${186-fan*12} ${-125+fold*90} 151Z`;
        sheet.querySelector('[data-leaf-shape]').setAttribute('d',shape);
        const highlight=sheet.querySelector('.folio-highlight');
        if(highlight)highlight.setAttribute('d',`M${-137+fold*75} -160Q${-8+fold*10} ${-143+fan*18} 125 ${-186+fold*38}`);
      });
      const oldDistance=index>=1?ease(Math.min(1,(elapsed-3000)/1000)):0;
      old.setAttribute('transform',`translate(${174-oldDistance*47} ${388+oldDistance*25}) rotate(${-oldDistance*12})`);
      old.setAttribute('opacity',String(index===0?0:index===7?0:.7));
      section.querySelector('[data-memory-orbit]').setAttribute('opacity',String(index>=2&&index<7?.8:0));
      const ribbon=section.querySelector('[data-action-ribbon]');
      ribbon.setAttribute('opacity',String(index===4||index===5?1:0));
      ribbon.querySelector('path').setAttribute('stroke-dashoffset',String(index===4?620*(1-ease(Math.min(1,within/1700))):0));
      // Validate, versioned save, then independent readback: no premature success mark.
      const verified=index>5 || (index===5 && within>=1800);
      stage.dataset.verified=String(verified);
      section.querySelector('[data-folio-result]').setAttribute('opacity',String(verified&&index<7?1:0));
      section.querySelector('[data-demo-version]').textContent=verified?'Demo v4 · readback matched':'Demo v3 · current trace';
      section.querySelector('[data-art-aside]').textContent=['One question','Selected context','This session','One bounded plan','Permitted action',within<800?'Validate':within<1800?'Save v4':'Read v4','Verified result','Session ended'][index];
      if(index!==current) {
        current=index; const step=MOTION_STEPS[index]; stage.dataset.step=String(index); section.dataset.step=String(index);
        get('number').textContent=`${String(index+1).padStart(2,'0')} / 08`;
        ['title','note','detail','event'].forEach((key,i)=>get(key).textContent=step[i]);
        get('status').textContent=`Step ${index+1} of 8. ${step[0]}. ${step[1]} ${step[2]}`;
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
