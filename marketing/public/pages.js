const demoLink = (label, className = '') => `<a class="${className}" href="/try-demo" data-demo-link>${label}<span aria-hidden="true">→</span></a>`;

export function renderManifesto() {
  return `<main class="manifesto" id="main-content">
    <section class="manifesto-intro container" aria-labelledby="manifesto-title">
      <div class="manifesto-copy"><p class="eyebrow">Manifesto</p><h1 id="manifesto-title">A demo should help someone<br class="desktop-break"> make up their mind.</h1><p class="lead">Every buyer arrives with a question about their own work.<br class="desktop-break"> The first demo should give them a useful way to answer it.</p></div>
      <img class="manifesto-art" src="/assets/manifesto.png" alt="" width="420" height="396">
    </section>
    <section class="manifesto-principles container" aria-label="Our principles">
      <article><span class="principle-number">01</span><h2>Start with their work.</h2><p>People bring a workflow, a problem, and a reason to look at your software. Their first demo should begin there.</p></article>
      <article><span class="principle-number">02</span><h2>Let them explore.</h2><p>Give buyers room to ask questions, try relevant examples, and follow what interests them.</p></article>
      <article><span class="principle-number">03</span><h2>Show what is true.</h2><p>Fictional demo data should make the product easier to understand. It should never suggest capabilities the product does not have.</p></article>
    </section>
    <section class="manifesto-closing"><div class="container"><p>That is what we are building Tailor for: a first demo grounded in the product, shaped around the buyer, and useful enough to help them decide.</p>${demoLink('Explore the Neatlogs example', 'text-link')}</div></section>
  </main>`;
}

const panels = [
  { id: 'context', label: 'Context & memory', columns: [
    ['Session memory, not a permanent profile.', 'A temporary session preserves the evolving demo and conversation. Persistent product knowledge lives separately.'],
    ['A bounded input for each turn.', 'Older turns and lower-priority details are trimmed first. Demo identity, versions, the story, and active-trace structure stay intact.']
  ], flow: ['Buyer statements', 'Recent turns + active demo', 'Bounded turn context'] },
  { id: 'knowledge', label: 'Knowledge', columns: [
    ['Product facts with a source.', 'Versioned capability records describe supported behavior, limitations, and relevant tools. They live separately from fictional demo data.'],
    ['Relevant records for this question.', 'A deterministic keyword index ranks the records. Up to six are included per turn; this implementation does not use a graph database.']
  ], flow: ['Buyer question', 'Keyword ranking', 'Up to six capability records'] },
  { id: 'adapter', label: 'Adapter & state', columns: [
    ['The product defines what can change.', 'The adapter supplies product-specific schemas and supported tools. Proposed changes are checked in code before they can update the demo.'],
    ['Save, then check the saved result.', 'A version check protects the current demo state. An independent readback verifies the result; a conflict or uncertain readback is surfaced rather than described as a successful change.']
  ], flow: ['Validate proposal', 'Save with version check', 'Independent readback'] },
  { id: 'guidance', label: 'Guidance', columns: [
    ['Suggestions point into the product.', 'Tailor can suggest supported destinations in the current demo, such as a trace or a relevant view. The buyer chooses what to open.'],
    ['Guidance stays tied to the demo.', 'Targets are checked against the saved demo and its version. Stale suggestions are disabled, and a missing destination is handled without pretending the navigation worked.']
  ], flow: ['Supported destination', 'Check demo + version', 'Buyer opens the view'] }
];

function renderEngineeringTabs() {
  return `<div class="engineering-tabs"><div role="tablist" aria-label="Explore Tailor engineering">${panels.map((p, i) => `<button type="button" role="tab" id="tab-${p.id}" aria-controls="panel-${p.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${p.label}</button>`).join('')}</div>${panels.map((p, i) => `<section class="engineering-panel" role="tabpanel" id="panel-${p.id}" aria-labelledby="tab-${p.id}" tabindex="0" ${i ? 'hidden' : ''}><div class="engineering-panel-columns">${p.columns.map(([title, body]) => `<div><h3>${title}</h3><p>${body}</p></div>`).join('')}</div><ol class="engineering-flow" aria-label="${p.label} flow">${p.flow.map(label => `<li>${label}</li>`).join('')}</ol></section>`).join('')}</div>`;
}

export function renderHowItWorks() {
  return `<main class="how-it-works" id="main-content">
    <section class="how-intro container" aria-labelledby="how-title"><div><p class="eyebrow">Inside Tailor</p><h1 id="how-title">One conversation.<br>A demo that moves with it.</h1><p class="lead">Ask about your workflow. Explore it in the product.<br class="desktop-break"> Then follow the question that matters next.</p><p class="example-note">The Neatlogs example · Fictional demo data</p></div><img class="how-art" src="/assets/how-it-works.png" width="500" height="400" alt=""></section>
    <section class="walkthrough container" aria-label="From a buyer question to an interactive demo">
      <article class="workflow-row"><div class="workflow-copy"><p class="eyebrow">01 / Start with your work</p><h2>Tell Tailor what matters.</h2><p>A buyer describes their workflow.<br class="desktop-break"> Tailor uses that context to shape the demo.</p></div><div class="example-surface"><p class="eyebrow">Buyer question</p><blockquote>“We handle delivery support.<br class="desktop-break"> Can I see that workflow?”</blockquote><div class="example-pair"><p><span>Buyer’s words</span>Delivery support</p><p><span>Tailor’s working interpretation</span>A delivery-support example</p></div></div></article>
      <article class="workflow-row"><div class="workflow-copy"><p class="eyebrow">02 / See it in the product</p><h2>Explore an example<br class="desktop-break"> that fits the question.</h2><p>Tailor adapts fictional demo data through<br class="desktop-break"> supported tools, then guides the buyer<br class="desktop-break"> to relevant product views.</p></div><div class="example-surface"><p class="eyebrow">Demo response / Illustrative</p><p class="example-statement">A fictional delivery-support<br class="desktop-break"> workflow, ready to explore.</p><ol class="demo-flow" aria-label="Demo workflow"><li>Adapt</li><li>Verify</li><li>Explore</li></ol><p class="example-caption">The explanation follows the saved result.<br class="desktop-break"> Guidance points to a supported view in that demo.</p></div></article>
      <article class="workflow-row"><div class="workflow-copy"><p class="eyebrow">03 / Keep exploring</p><h2>Follow the next question.</h2><p>The next answer builds on the same workflow,<br class="desktop-break"> saved demo, and view the buyer is exploring.</p></div><div class="example-surface"><p class="eyebrow">Buyer follow-up</p><blockquote>“Where did this request<br class="desktop-break"> slow down?”</blockquote><div class="example-pair"><p><span>Context carried forward</span>Workflow + saved trace</p><p><span>Relevant guidance</span>Inspect the longest step</p></div></div></article>
    </section>
    <section class="engineering container" aria-labelledby="engineering-title"><div class="engineering-heading"><div><p class="eyebrow">Under the surface</p><h2 id="engineering-title">Three parts keep the demo grounded.</h2></div><a href="#engineering-detail">Explore the engineering <span aria-hidden="true">↓</span></a></div><div class="engineering-summary"><article><h3>Context</h3><p>Buyer statements, the working story,<br class="desktop-break"> recent turns, and the active demo.<br class="desktop-break"> Bounded to what this turn needs.</p></article><article><h3>Product knowledge</h3><p>Versioned capability records,<br class="desktop-break"> ranked by a keyword index.<br class="desktop-break"> Up to six records per turn.</p></article><article><h3>Adapter</h3><p>Product-specific schemas and tools.<br class="desktop-break"> Validate, save with a version check,<br class="desktop-break"> then independently read back.</p></article></div><div id="engineering-detail">${renderEngineeringTabs()}</div></section>
    <section class="how-closing"><div class="container"><h2>See it for yourself.</h2><p>Try the conversation in Neatlogs,<br>Tailor’s first example adapter.</p>${demoLink('Explore the Neatlogs demo', 'button')}</div></section>
  </main>`;
}

export function attachPageInteractions(root = document) {
  root.querySelectorAll('.how-it-works [role="tablist"]').forEach(list => {
    if (list.dataset.bound) return;
    list.dataset.bound = 'true';
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const activate = (tab, focus = false) => {
      tabs.forEach(item => {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        const panel = root.querySelector(`#${item.getAttribute('aria-controls')}`);
        if (panel) panel.hidden = !active;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); activate(tabs[next], true); }
      });
    });
  });
}
