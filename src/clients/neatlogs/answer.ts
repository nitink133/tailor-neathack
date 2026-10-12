// Product answers are COMPOSED BY CODE from the cited CapabilityRecords. Provider prose never carries a claim into the
// reply: at most one short lead sentence survives, and only if it passes the claim filter below (no prices, no plan
// names the records don't list, no capability claims the records don't support).

import type { CapabilityRecord } from './agent-contract.ts';
import { clip, cleanNarrative } from '../../tailor/text.ts';
import { PLAN_WORDS, allWordsGroundedIn, hasBlanketPlanClaim, hasLimitNumber, hasPricingClaim, hasUngroundableNumber, shadowOf, splitSentences } from './claims.ts';

const MAX_LEAD_CHARS = 200;
const PRICING_QUESTION = /\b(?:pric(?:e|es|ed|ing)|costs?|how much|plans?|tiers?|subscriptions?|billing|billed|licen[cs]es?|paid|free|per (?:seat|month|user|year))\b/i;
const CAPABILITY_VERB = /\b(?:offers?|provides?|includes?|has|have|can|keeps?|retains?|stores?|pages?|available|gives?|lets?|allows?|enables?|supports?|detects?|integrates?|integrations?|alerts?|exports?|notif(?:y|ies)|sends?|connects?|monitors?|replays?|streams?|automates?|blocks?|prevents?|guarantees?)\b/i;
const STOP = new Set(['that', 'this', 'with', 'from', 'your', 'their', 'them', 'they', 'them', 'will', 'also', 'such', 'when', 'where', 'which', 'what', 'into', 'than', 'then', 'only', 'more', 'most', 'some', 'each', 'every', 'both', 'does', 'have', 'been', 'being', 'neatlogs', 'tailor', 'demo', 'agent', 'agents']);

const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const endSentence = (s: string): string => { const t = s.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function recordText(r: CapabilityRecord): string {
  return [r.title, r.behaviour, r.buyerProblem, ...r.limitations, ...r.prerequisites, ...r.topics, r.demonstration.evidence, ...r.demonstration.cloneSurfaces].join(' ');
}

/** True when `word` (4+ letters) is present in the cited records, tolerating simple inflection by a 5-letter stem. */
function supportedBy(word: string, vocabulary: string[]): boolean {
  return vocabulary.some(t => t === word || (word.length >= 6 && t.length >= 5 && t.slice(0, 5) === word.slice(0, 5)));
}

/** A provider sentence is safe only if it makes no price, plan or capability claim the cited records don't back. */
export function sentencePassesAnswerFilter(raw: string, cited: CapabilityRecord[]): boolean {
  const sentence = shadowOf(raw);
  if (/https?:\/\//i.test(sentence) || hasUngroundableNumber(sentence)) return false;
  if (hasPricingClaim(sentence) || hasBlanketPlanClaim(sentence) || hasLimitNumber(sentence)) return false;
  const plans = new Set(cited.flatMap(r => (r.planAvailability.status === 'known' ? r.planAvailability.plans : [])).map(p => p.toLowerCase()));
  const planHits = [...sentence.matchAll(PLAN_WORDS)].map(m => m[1]!.toLowerCase());
  for (const hit of planHits) if (![...plans].some(p => p === hit || tokens(p).includes(hit))) return false;
  const verb = CAPABILITY_VERB.exec(sentence);
  if (verb) {
    const vocabulary = cited.flatMap(r => tokens(recordText(r)));
    const objectWords = tokens(sentence.slice(verb.index + verb[0].length)).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
    if (objectWords.some(w => !supportedBy(w, vocabulary))) return false;
  }
  return true;
}

/**
 * At most one short lead sentence from the provider. It must be an exact supported source sentence as well as passing
 * the claim filter; word overlap cannot establish polarity or meaning. The rest of the answer
 * is code-composed from the records). '' when nothing survives or it would only repeat the records.
 */
export function filteredLead(providerText: string, cited: CapabilityRecord[], body: string): string {
  const first = splitSentences(cleanNarrative(providerText))[0];
  if (!first || first.length > MAX_LEAD_CHARS) return '';
  if (!sentencePassesAnswerFilter(first, cited)) return '';
  const sourceSentences = cited.flatMap(r => [r.behaviour, ...r.limitations].flatMap(splitSentences));
  if (!sourceSentences.some(source => squash(source) === squash(first))) return '';
  if (squash(body).includes(squash(first))) return '';
  return endSentence(first);
}

/**
 * Buyer-facing wording for stored/API reply text. Knowledge records use internal terms (repo source ids, "clone",
 * "slice", "explain-only"); none of them reaches a reply. The browser applies the same mapping as defence in depth.
 */
export function buyerWording(text: string): string {
  const matchCase = (word: string, replacement: string) => (word[0] === word[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement);
  return text
    .replace(/repo:[\w./-]+/g, 'product knowledge')
    .replace(/\bexplain-only\b/gi, w => matchCase(w, 'view-only'))
    .replace(/\b(the|this|a) (?:clone|slice)\b/gi, (_w, article: string) => `${article} demo`)
    .replace(/\b(?:clone|slice)\b/gi, w => matchCase(w, 'demo'));
}

/** Human source titles with their verified dates, then the knowledge version the answer was composed from. */
function sourceLine(cited: CapabilityRecord[], knowledgeVersion?: string): string {
  const parts = cited.map(r => {
    const dates = [...new Set(r.sources.slice(0, 2).map(s => s.verifiedOn))];
    return dates.length ? `${r.title} (verified ${dates.join(', ')})` : r.title;
  });
  return `Sources: ${parts.join('; ')}${knowledgeVersion ? `; knowledge version ${knowledgeVersion}` : ''}.`;
}

function demonstrationLine(r: CapabilityRecord): string {
  switch (r.demonstration.level) {
    case 'demonstrable': return `In this demo ${r.title} is shown for real on synthetic data (${clip(r.demonstration.evidence, 160)}).`;
    case 'modifiable': return `In this demo you can change ${r.title} through the conversation (${clip(r.demonstration.evidence, 160)}).`;
    case 'explain_only': return `In this demo ${r.title} is view-only: I can describe it but not run it.`;
    case 'unsupported': return `In this demo ${r.title} is not available.`;
  }
}

function planLine(r: CapabilityRecord): string {
  const p = r.planAvailability;
  if (p.status === 'unknown') return `Plan availability for ${r.title}: unknown. ${clip(p.note, 200)}`.trim();
  return `${r.title} is listed for: ${p.plans.join(', ') || 'no plans recorded'}.${p.note ? ` ${clip(p.note, 160)}` : ''}`;
}

/**
 * Deterministic reply built only from the cited records: title, behaviour, key limitations, prerequisites,
 * demonstration level, sources (URL + verified date) and plan availability (unknown stated plainly, and last).
 */
function detailedAnswer(cited: CapabilityRecord[], question: string, providerText: string, knowledgeVersion?: string): string {
  const blocks: string[] = [];
  for (const [index, r] of cited.entries()) {
    const lines = [`${index + 1}. ${r.title}`, endSentence(clip(r.behaviour, 420))];
    if (r.limitations.length) lines.push(`- Limits: ${r.limitations.slice(0, 2).map(l => clip(l, 160).replace(/[.!?]+$/, '')).join('; ')}.`);
    if (r.prerequisites.length) lines.push(`- You’d need: ${r.prerequisites.slice(0, 2).map(l => clip(l, 160).replace(/[.!?]+$/, '')).join('; ')}.`);
    lines.push(`- ${demonstrationLine(r)}`);
    blocks.push(lines.join('\n'));
  }
  const body = blocks.join('\n\n');
  const lead = filteredLead(providerText, cited, body);
  const pricing = PRICING_QUESTION.test(question) || cited.some(r => /pric/i.test(`${r.id} ${r.title} ${r.topics.join(' ')}`));
  const out: string[] = [];
  if (lead) out.push(lead);
  out.push(...blocks, sourceLine(cited, knowledgeVersion));
  if (pricing) out.push('I don’t have verified prices, so I won’t quote any.');
  // Plan lines come last so a pricing answer always ends with the record's own unknown statement.
  out.push(cited.map(planLine).join('\n'));
  return buyerWording(out.join('\n\n'));
}


const MAX_ANSWER_CHARS = 2000;
const QUESTION_FILLER = new Set([...STOP, 'kind', 'kinds', 'implement', 'help', 'about', 'tell', 'could', 'would', 'should', 'how', 'can', 'and', 'the', 'for', 'are', 'you']);
const topicTokens = (text: string) => tokens(text).map(t => /^eval(?:s|uation|uations|uator|uators)?$/.test(t) ? 'eval' : t);
/** Keep source sentences whole: the core's final safety ceiling must never cut our reply. */
function wholeSentences(text: string, budget: number): string {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    const next = endSentence(sentence);
    if ([...out, next].join(' ').length > budget) break;
    out.push(next);
  }
  return out.join(' ');
}

/** A fixed workflow example translates cited instrumentation facts without admitting provider-authored claims. */
function codeReviewFit(cited: CapabilityRecord[], question: string, knowledgeVersion?: string): string | null {
  if (!/\b(?:code[ -]?review|pull requests?|PRs?)\b/i.test(question) || !/\b(?:make sense|use ?case|fit|suitable|should.*use)\b/i.test(question)) return null;
  const traces = cited.find(r => r.id === 'official-traces-and-spans' && r.scope === 'official_product');
  const sdk = cited.find(r => r.id === 'official-typescript-sdk' && r.scope === 'official_product');
  if (!traces || !sdk) return null;
  const records = [traces, sdk];
  const lines = [
    'Neatlogs makes sense as an observability layer for a code-review agent if you want to inspect how each review ran and investigate slow or failed steps.',
    '1. Instrument each PR review run',
    'For example, you could record one trace per review and spans for your agent’s steps, such as reading a diff, calling a model and preparing feedback. Capture the inputs, outputs, timing and errors you need to inspect. This is a suggested instrumentation design for your agent.',
    '2. Use the saved evidence to debug',
    'Inspect the recorded steps to see where time was spent or an error occurred, and read the captured input and output to understand the feedback your agent produced. What you can inspect depends on what you instrument.',
    '3. Keep the integration boundary clear',
    'Your application would own the PR-review workflow and posting feedback. These cited records establish trace inspection and instrumentation, not an automatic PR reviewer or a guarantee that the feedback is correct.',
    '- Limits: TypeScript instrumentation is explicit; the documented SDK has no auto-instrumentation option. Your application must flush or shut down appropriately for its process lifecycle.',
    '- In this demo you can inspect synthetic traces. A real agent integration is not demonstrated here.',
    sourceLine(records, knowledgeVersion),
    ...records.map(planLine),
  ];
  return buyerWording(lines.join('\n\n'));
}

/** Ordinary short answers retain their detail. Broad answers reserve room for sources and availability first. */
export function composeAnswer(cited: CapabilityRecord[], question: string, providerText: string, knowledgeVersion?: string): string {
  const fit = codeReviewFit(cited, question, knowledgeVersion);
  if (fit && fit.length <= MAX_ANSWER_CHARS) return fit;
  const detailed = detailedAnswer(cited, question, providerText, knowledgeVersion);
  if (detailed.length <= MAX_ANSWER_CHARS) return detailed;
  const wanted = new Set(topicTokens(question).filter(t => t.length >= 3 && !QUESTION_FILLER.has(t)));
  const score = (r: CapabilityRecord) => {
    const topical = new Set(topicTokens(r.title));
    const body = new Set(topicTokens(r.behaviour));
    return [...wanted].reduce((n, word) => n + (topical.has(word) ? 3 : body.has(word) ? 1 : 0), 0);
  };
  const ranked = cited.map((r, index) => ({ r, index, score: score(r) })).sort((a, b) => b.score - a.score || a.index - b.index);
  let kept = ranked.filter(x => x.score > 0).map(x => x.r).slice(0, 3);
  if (!kept.length) kept = ranked.slice(0, 2).map(x => x.r);
  const pricing = PRICING_QUESTION.test(question) || kept.some(r => /pric/i.test(`${r.id} ${r.title} ${r.topics.join(' ')}`));
  const compact = (records: CapabilityRecord[]) => {
    const blocks = records.map((r, index) => {
      const lines = [`${index + 1}. ${r.title}`, wholeSentences(r.behaviour, 350)];
      const limits = r.limitations.map(l => wholeSentences(l, 160)).filter(Boolean).slice(0, 2);
      if (limits.length) lines.push(`- Limits: ${limits.join(' ')}`);
      if (r.demonstration.level === 'explain_only') lines.push('- In this demo I can describe this capability but not run it.');
      else if (r.demonstration.level === 'unsupported') lines.push('- This capability is not available in this demo.');
      else lines.push('- This demo uses synthetic data.');
      return lines.filter(Boolean).join('\n');
    });
    const unknown = records.filter(r => r.planAvailability.status === 'unknown');
    const availability = records.filter(r => r.planAvailability.status === 'known').map(planLine);
    if (unknown.length) availability.push(`Plan availability for ${unknown.map(r => r.title).join('; ')}: unknown.`);
    return buyerWording([...blocks, sourceLine(records, knowledgeVersion), ...(pricing ? ['I don’t have verified prices, so I won’t quote any.'] : []), ...availability].join('\n\n'));
  };
  let answer = compact(kept);
  while (answer.length > MAX_ANSWER_CHARS && kept.length > 1) { kept = kept.slice(0, -1); answer = compact(kept); }
  return answer;
}
