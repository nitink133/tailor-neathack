// Product answers are COMPOSED BY CODE from the cited CapabilityRecords. Provider prose never carries a claim into the
// reply: at most one short lead sentence survives, and only if it passes the claim filter below (no prices, no plan
// names the records don't list, no capability claims the records don't support).

import type { CapabilityRecord } from '../agent-contract.ts';
import { clip } from './context.ts';
import { cleanNarrative, hasPricingClaim, splitSentences } from './explain.ts';

const MAX_LEAD_CHARS = 200;
const PRICING_QUESTION = /\b(?:pric(?:e|es|ed|ing)|costs?|how much|plans?|tiers?|subscriptions?|billing|billed|licen[cs]es?|paid|free|per (?:seat|month|user|year))\b/i;
const PLAN_WORDS = /\b(free|pro|team|enterprise|starter)\b/gi;
const CAPABILITY_VERB = /\b(?:supports?|detects?|integrates?|integrations?|alerts?|exports?|notif(?:y|ies)|sends?|connects?|monitors?|replays?|streams?|automates?|blocks?|prevents?|guarantees?)\b/i;
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
export function sentencePassesAnswerFilter(sentence: string, cited: CapabilityRecord[]): boolean {
  if (/https?:\/\//i.test(sentence)) return false;
  if (hasPricingClaim(sentence)) return false;
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

/** At most one short, filtered lead sentence from the provider; '' when nothing survives or it would only repeat the records. */
export function filteredLead(providerText: string, cited: CapabilityRecord[], body: string): string {
  const first = splitSentences(cleanNarrative(providerText))[0];
  if (!first || first.length > MAX_LEAD_CHARS) return '';
  if (!sentencePassesAnswerFilter(first, cited)) return '';
  if (squash(body).includes(squash(first))) return '';
  return endSentence(first);
}

function sourceLine(cited: CapabilityRecord[]): string {
  const parts = cited.map(r => r.sources.length
    ? `${r.title} — ${r.sources.slice(0, 2).map(s => `${s.url} (verified ${s.verifiedOn})`).join(', ')}`
    : r.title);
  return `Sources: ${parts.join('; ')}.`;
}

function demonstrationLine(r: CapabilityRecord): string {
  switch (r.demonstration.level) {
    case 'demonstrable': return `In this demo ${r.title} is shown for real on synthetic data (${clip(r.demonstration.evidence, 160)}).`;
    case 'modifiable': return `In this demo you can change ${r.title} through the conversation (${clip(r.demonstration.evidence, 160)}).`;
    case 'explain_only': return `In this demo ${r.title} is explain-only: I can describe it but not run it.`;
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
export function composeAnswer(cited: CapabilityRecord[], question: string, providerText: string): string {
  const blocks: string[] = [];
  for (const r of cited) {
    const lines = [`${r.title}: ${endSentence(clip(r.behaviour, 420))}`];
    if (r.limitations.length) lines.push(`Limits: ${r.limitations.slice(0, 2).map(l => clip(l, 160).replace(/[.!?]+$/, '')).join('; ')}.`);
    if (r.prerequisites.length) lines.push(`You’d need: ${r.prerequisites.slice(0, 2).map(l => clip(l, 160).replace(/[.!?]+$/, '')).join('; ')}.`);
    lines.push(demonstrationLine(r));
    blocks.push(lines.join(' '));
  }
  const body = blocks.join('\n');
  const lead = filteredLead(providerText, cited, body);
  const pricing = PRICING_QUESTION.test(question) || cited.some(r => /pric/i.test(`${r.id} ${r.title} ${r.topics.join(' ')}`));
  const out: string[] = [];
  if (lead) out.push(lead);
  out.push(...blocks, sourceLine(cited));
  if (pricing) out.push('I don’t have verified prices, so I won’t quote any.');
  // Plan lines come last so a pricing answer always ends with the record's own unknown statement.
  out.push(...cited.map(planLine));
  return out.join('\n');
}
