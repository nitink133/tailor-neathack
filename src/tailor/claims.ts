// ONE source of truth for "what must never reach the buyer as model prose": prices, plan/tier names, capability
// assertions about the product, retention/limit numbers and URLs. Everything that filters model text (answer lead
// sentences, explanation narratives, refuse/unsupported replies, clarification questions and labels) uses these rules.
// The filters are conservative by design: dropping a harmless sentence is fine, letting an invented claim through is not.
// Rules that name the product are built by `createClaimRules(productNames)`; the rest are product-independent.

/** Sentence split that keeps decimals ("2.86 s") and identifiers intact. */
export function splitSentences(text: string): string[] {
  return (text.replace(/\s+/g, ' ').trim().match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)/g) ?? []).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------------------
const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|INR|CAD|AUD)\b/i;
const PRICE_UNIT = /\d[\d,.]*\s*(?:dollars?|euros?|pounds?|bucks|usd|eur|gbp)\b|\bper\s+(?:month|year|seat|user|mo|yr|team|project)\b|\/\s*(?:mo|month|yr|year|seat|user)\b|\ba\s+(?:month|year)\b|\b(?:monthly|annually|yearly)\b|\bpricing\s+tiers?\b|\b(?:costs?|priced|billed)\b[^.]{0,40}\d/i;
const FREE_OR_NO_CHARGE = /\bno\s+(?:extra|additional|added|hidden)\s+(?:charges?|costs?|fees?)\b|\bat\s+no\s+(?:extra\s+|additional\s+)?cost\b|\bfree\s+of\s+charge\b|\bfor\s+free\b|\bcomplimentary\b|\bwithout\s+(?:any\s+)?(?:extra\s+)?(?:charge|fee)s?\b/i;

/** A sentence that states a price, a billing amount, a pricing tier or "free/no extra charge". Product copy may say "pricing" with no number. */
export function hasPricingClaim(sentence: string): boolean {
  return CURRENCY.test(sentence) || PRICE_UNIT.test(sentence) || FREE_OR_NO_CHARGE.test(sentence);
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans / tiers
// ---------------------------------------------------------------------------------------------------------------------
/** Plan words, global so callers can matchAll them against the plans a cited record actually lists. */
export const PLAN_WORDS = /\b(free|pro|team|enterprise|starter)\b/gi;
const PLAN_NAMES = '(?:free|pro|team|teams|enterprise|starter|business|premium|growth|basic|standard|plus|hobby|developer)';
const NAMED_PLAN = new RegExp(`\\b${PLAN_NAMES}\\s+(?:plans?|tiers?|editions?|subscriptions?|licen[cs]es?|accounts?|versions?|packages?)\\b`, 'i');
const BLANKET_PLAN = /\b(?:every|all|any|each|higher|paid|premium|top|lower|other)\s+(?:plans?|tiers?|editions?)\b|\b(?:plans?|tiers?)\s+(?:include|includes|start|starts|differ)\b|\bupgrad(?:e|ed|es|ing)\b|\b(?:included|bundled)\s+(?:in|with)\b/i;
const BARE_PLAN = /\b(?:enterprise|premium)\b/i;
const CAPITAL_PLAN = /\b(?:on|in|with|under|for|to)\s+(?:the\s+)?(?:Pro|Team|Teams|Free|Starter|Business)\b/;

/** "every plan", "all plans", "included in", upgrade wording: a claim about WHICH plans have something. */
export function hasBlanketPlanClaim(sentence: string): boolean {
  return BLANKET_PLAN.test(sentence);
}

// ---------------------------------------------------------------------------------------------------------------------
// Retention / limit numbers
// ---------------------------------------------------------------------------------------------------------------------
// Time/count units that evidence can ground (ms, minutes, %, counts) are NOT here: adapters check those against readback.
const LIMIT_NUMBER = /\b\d[\d,.]*\s*(?:days?|weeks?|months?|years?|[kmgt]b|seats?|users?|members?|projects?|events?|requests?|retention)\b|\b(?:up\s+to|at\s+most|at\s+least|maximum|max|limit(?:ed)?\s+(?:to|of)|quota|cap(?:ped)?\s+(?:at|of)|retention|retained|retains?|retain|keeps?\s+(?:your|traces?|data))\b[^.]{0,40}\d|\d[^.]{0,40}\b(?:retention|quota|rate\s+limit|limit\s+per)\b/i;

/** A retention period, quota or other limit stated as a number. */
export function hasLimitNumber(sentence: string): boolean {
  return LIMIT_NUMBER.test(sentence);
}

// ---------------------------------------------------------------------------------------------------------------------
// Capability assertions about the product
// ---------------------------------------------------------------------------------------------------------------------
const CLAIM_VERBS = 'can|could|will|would|does|do|offers?|provides?|includes?|supports?|pages?|alerts?|notif(?:y|ies)|retains?|stores?|keeps?|integrates?|sends?|detects?|fix(?:es)?|monitors?|exports?|has|have|gives?|lets?|allows?|enables?|connects?|covers?|ships?|comes|automates?|automatically|blocks?|prevents?|guarantees?|replays?|streams?|handles?|runs?|routes?|posts?|escalates?';
const ADVERBS = 'also|then|just|only|already|even|really|would|will|can|could|still|automatically|natively|directly|always|never|simply|now|soon|typically|usually|generally';
const GENERIC_PRODUCT = "the\\s+(?:platform|product|tool|service|app)|this\\s+(?:platform|product|feature)|(?:the|that)\\s+feature";
const MODAL_ACTION = /\b(?:can|could|will|would)\s+(?:also\s+)?(?:page|notify|alert|send|post|route|export|integrate|retain|store|keep|detect|fix|monitor|replay|block|prevent|escalate|automate|connect)\b/i;
const OTHER_CLAIM = /\bautomatically\b|\b(?:is|are)\s+(?:also\s+)?(?:available|included|supported|offered|bundled)\b|\b(?:offers?|provides?|supports?|integrates?|retains?)\b|\bout\s+of\s+the\s+box\b/i;

/** The sentence is explicitly about THIS demo's limits (or says nothing was changed), so a capability word there is not a product claim. */
const DEMO_SCOPE = /\bthis\s+(?:demo|clone|prototype|replica|app|build)\b|\bin\s+(?:this|the)\s+(?:demo|clone|prototype|replica)\b|\bhere\b|\boutside\s+(?:of\s+)?(?:what|this|the\s+demo|the\s+clone)\b|\b(?:i|we|tailor)\s+(?:can(?:['’]t|not)|cannot|won(?:['’]t)|am\s+unable|(?:['’]m)\s+unable|(?:do\s+not|don(?:['’]t))\s+have)\b|\bnothing\s+(?:was|has\s+been|is)\s+(?:changed|saved|published|sent)\b|\bunable\s+to\b/i;

export function isDemoScoped(clause: string): boolean {
  return DEMO_SCOPE.test(clause);
}

const CLAUSE_BREAK = /[;:,—–()]|\s-\s|\b(?:but|and|though|although|while|whereas|so|because|since)\b/i;
const URL_TEXT = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|org|net|dev|ai|app)\b/i;

// ---------------------------------------------------------------------------------------------------------------------
// Vocabulary grounding (shared by answer lead sentences)
// ---------------------------------------------------------------------------------------------------------------------
const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Neutral function/glue words that need no support from the cited records (product names are added per product). */
const GLUE_WORDS = ['that', 'this', 'with', 'from', 'your', 'their', 'them', 'they', 'will', 'also', 'such', 'when', 'where', 'which', 'what', 'into', 'than', 'then', 'only', 'more', 'most', 'some', 'each', 'every', 'both', 'does', 'have', 'been', 'being', 'tailor', 'demo', 'agent', 'agents', 'here', 'there', 'about', 'would', 'could', 'should', 'using', 'used', 'uses', 'show', 'shows', 'shown', 'just', 'still', 'even', 'many', 'much', 'other', 'these', 'those', 'well', 'while', 'after', 'before', 'once', 'same', 'like', 'make', 'makes', 'made', 'take', 'takes', 'look', 'looks', 'mean', 'means', 'work', 'works', 'help', 'helps', 'because', 'between', 'through'];

/** Light stem: plural/-ing/-ed/-es/-ies, so "retries"~"retry" and "failing"~"failed". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  }
  return w;
}

function wordSupported(word: string, vocabulary: Set<string>, stems: Set<string>): boolean {
  if (vocabulary.has(word)) return true;
  const s = stem(word);
  if (stems.has(s)) return true;
  if (s.length < 5) return false;
  for (const known of stems) if (known.length >= 5 && (known.startsWith(s) || s.startsWith(known))) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Product-named rules
// ---------------------------------------------------------------------------------------------------------------------
export interface ClaimRules {
  /** Any plan/tier/edition wording, named or blanket. */
  hasPlanClaim(sentence: string): boolean;
  /** The raw capability-assertion patterns, ignoring demo scope. */
  hasCapabilityAssertion(sentence: string): boolean;
  /**
   * A capability assertion about the product that is not itself scoped to this demo. Judged clause by clause, so
   * "<Product> can page PagerDuty, but I can't do that here" is still a claim (the first clause is unscoped).
   */
  hasCapabilityClaim(sentence: string): boolean;
  /** True when the sentence states a price, plan, capability, limit number or link that nothing here can ground. */
  isUngroundedClaim(sentence: string): boolean;
  /** Keep only neutral sentences of model prose. Returns '' when nothing survives. */
  stripUngroundedClaims(text: string): string;
  /**
   * Clarification questions and labels describe the BUYER's workflow, so the generic it/they capability pattern would
   * reject legitimate options. Only prices, plans, limit numbers, links and claims whose subject is the product itself
   * are dropped. Returns '' when nothing survives; callers treat that as a malformed clarification.
   */
  sanitiseClarificationText(text: string): string;
  /**
   * Every content word (4+ letters, not glue) and every number in `sentence` must appear in `sourceText`
   * (the cited records' text), tolerating simple inflection. Used to keep model lead sentences to what records say.
   */
  allWordsGroundedIn(sentence: string, sourceText: string): boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createClaimRules(productNames: readonly string[]): ClaimRules {
  const names = productNames.map(n => n.trim().toLowerCase()).filter(Boolean);
  // A product-free configuration must never match: `(?!)` is the empty-alternative guard.
  const product = names.length ? `(?:${names.map(escape).join('|')})` : '(?!)';
  const subject = `(?:${product}(?:['’]s)?|it|they|${GENERIC_PRODUCT})`;
  const namedSubject = `(?:${product}(?:['’]s)?|${GENERIC_PRODUCT})`;
  const SUBJECT_CLAIM = new RegExp(`\\b${subject}\\s+(?:(?:${ADVERBS})\\s+){0,3}(?:${CLAIM_VERBS})\\b(?!['’]t)`, 'i');
  const PRODUCT_NAMED_CLAIM = new RegExp(`\\b${namedSubject}\\s+(?:(?:${ADVERBS})\\s+){0,3}(?:${CLAIM_VERBS})\\b(?!['’]t)`, 'i');
  const PRODUCT_PLAN = new RegExp(`\\b${product}\\s+(?:free|pro|team|teams|enterprise|starter|business|premium)\\b`, 'i');
  const glue = new Set([...GLUE_WORDS, ...names.flatMap(tokens)]);

  const hasPlanClaim = (s: string) => NAMED_PLAN.test(s) || BLANKET_PLAN.test(s) || PRODUCT_PLAN.test(s) || BARE_PLAN.test(s) || CAPITAL_PLAN.test(s);
  const hasCapabilityAssertion = (s: string) => SUBJECT_CLAIM.test(s) || MODAL_ACTION.test(s) || OTHER_CLAIM.test(s);
  const hasCapabilityClaim = (s: string) => s.split(CLAUSE_BREAK).some(clause => hasCapabilityAssertion(clause) && !isDemoScoped(clause));
  const isUngroundedClaim = (s: string) => hasPricingClaim(s) || hasPlanClaim(s) || hasLimitNumber(s) || hasCapabilityClaim(s) || URL_TEXT.test(s);

  return {
    hasPlanClaim, hasCapabilityAssertion, hasCapabilityClaim, isUngroundedClaim,
    stripUngroundedClaims(text) {
      if (!text) return '';
      const cleaned = text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, '');
      return splitSentences(cleaned).filter(s => !isUngroundedClaim(s)).join(' ').trim();
    },
    sanitiseClarificationText(text) {
      if (!text) return '';
      const cleaned = text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, '');
      const isClaim = (s: string) => hasPricingClaim(s) || hasPlanClaim(s) || hasLimitNumber(s) || URL_TEXT.test(s)
        || s.split(CLAUSE_BREAK).some(clause => PRODUCT_NAMED_CLAIM.test(clause) && !isDemoScoped(clause));
      return splitSentences(cleaned).filter(s => !isClaim(s)).join(' ').trim();
    },
    allWordsGroundedIn(sentence, sourceText) {
      const vocabulary = new Set(tokens(sourceText));
      const stems = new Set([...vocabulary].map(stem));
      for (const t of tokens(sentence)) {
        if (/^\d+$/.test(t)) { if (!vocabulary.has(t)) return false; continue; }
        if (t.length < 4 || glue.has(t)) continue;
        if (!wordSupported(t, vocabulary, stems)) return false;
      }
      return true;
    },
  };
}
