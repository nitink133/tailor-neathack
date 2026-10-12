const arrow = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 9h13M10 4l5 5-5 5" stroke="currentColor" stroke-width="1.5"/></svg>';

export function renderLanding() {
  return `<main class="landing" id="main-content">
    <section class="landing-hero container" aria-labelledby="landing-title">
      <div class="landing-promise">
        <p class="eyebrow landing-eyebrow">A DEMO AGENT FOR SOFTWARE COMPANIES</p>
        <h1 id="landing-title">Give buyers a first demo<br class="landing-desktop-break"> of their own.</h1>
        <p class="landing-introduction">Tailor turns buyer questions into a personalized demo.<br class="landing-desktop-break"> It adapts fictional data, guides product exploration,<br class="landing-desktop-break"> and keeps context as they ask more.</p>
        <a class="button landing-demo-button" href="/try-demo" data-demo-link>Try it with Neatlogs ${arrow}</a>
      </div>
      <img class="landing-art" src="/assets/landing.png" alt="" width="570" height="490" fetchpriority="high">
    </section>
    <section class="landing-value" aria-labelledby="landing-value-title">
      <div class="container landing-value-content">
        <h2 id="landing-value-title">It changes the demo, not just the conversation.</h2>
        <div class="landing-benefits">
          <article class="landing-benefit">
            <span class="landing-number" aria-hidden="true">01</span>
            <h3>Adapts the demo data.</h3>
            <p>Fictional examples change to match the buyer’s workflow.</p>
          </article>
          <article class="landing-benefit">
            <span class="landing-number" aria-hidden="true">02</span>
            <h3>Guides them in the product.</h3>
            <p>Points to relevant product views and explains what to look at.</p>
          </article>
          <article class="landing-benefit">
            <span class="landing-number" aria-hidden="true">03</span>
            <h3>Carries the context forward.</h3>
            <p>The next question builds on the same workflow and demo context.</p>
          </article>
        </div>
        <div class="landing-example" aria-label="An example buyer conversation">
          <div><p class="landing-example-label">A BUYER SAYS</p><p>“We handle delivery support.”</p></div>
          <div><p class="landing-example-label">TAILOR ADAPTS</p><p>Fictional examples for that workflow.</p></div>
          <div><p class="landing-example-label">THE BUYER FOLLOWS UP</p><p>“What happens when it fails?”</p></div>
        </div>
      </div>
    </section>
    <section class="landing-closing" aria-labelledby="landing-closing-title">
      <div class="container landing-closing-content">
        <h2 id="landing-closing-title">Try the first example.</h2>
        <p>Neatlogs is the first Tailor adapter.<br>Explore it with fictional demo data.</p>
        <a class="button landing-demo-button landing-button-dark" href="/try-demo" data-demo-link>Explore the Neatlogs demo ${arrow}</a>
      </div>
    </section>
  </main>`;
}
