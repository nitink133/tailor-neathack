import {renderLanding} from './landing.js';
import {renderManifesto,renderHowItWorks,attachPageInteractions} from './pages.js';

const path = location.pathname;
const route = path === '/manifesto' ? 'manifesto' : path === '/how-it-works' ? 'how-it-works' : 'landing';
document.title = route === 'manifesto' ? 'Manifesto · Tailor' : route === 'how-it-works' ? 'How it works · Tailor' : 'Tailor — A demo of their own';
const nav = (footer = false) => `<nav aria-label="${footer?'Footer':'Main'} navigation"><a href="/how-it-works" ${route==='how-it-works'?'aria-current="page"':''}>How it works</a><a href="/manifesto" ${route==='manifesto'?'aria-current="page"':''}>Manifesto</a><a href="/try-demo" data-demo-link>The demo</a></nav>`;
document.querySelector('#website').innerHTML = `<a class="skip-link" href="#main-content">Skip to content</a><header class="site-header container"><a class="wordmark" href="/" aria-label="Tailor home">tailor</a>${nav()}</header>${route==='manifesto'?renderManifesto():route==='how-it-works'?renderHowItWorks():renderLanding()}<footer class="site-footer container"><p>tailor / A demo agent for software companies.</p>${nav(true)}</footer>`;
attachPageInteractions();
