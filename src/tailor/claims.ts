// ONE source of truth for "what must never reach the buyer as model prose": prices, plan/tier names, capability
// assertions about the product, retention/limit numbers, URLs and numbers nothing can ground. Everything that filters
// model text (answer lead sentences, explanation narratives, refuse/unsupported replies, clarification questions and
// labels) uses these rules. The filters are conservative by design: dropping a harmless sentence is fine, letting an
// invented claim through is not. Rules that name the product are built by `createClaimRules(productNames)`.
//
// Every check runs on a NORMALISED shadow of the sentence: Unicode NFKC first (full-width "３" becomes "3"), then number
// words become digits (`numberWordsToDigits`), so "five hundred three", "twice" and "９" are checked exactly like "503",
// "2 times" and "9". Any numeral still outside ASCII after NFKC (e.g. Arabic-Indic digits) is treated as an ungrounded
// number. Callers keep the NFKC text for display; only the checks use the shadow.

import { defence, normaliseProse } from './text.ts';

/** Sentence split that keeps decimals ("2.86 s") and identifiers intact. */
export function splitSentences(text: string): string[] {
  return (text.replace(/\s+/g, ' ').trim().match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)/g) ?? []).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers: Unicode numerals and number words
// ---------------------------------------------------------------------------------------------------------------------
/** A decimal digit or other numeric character that is not ASCII 0-9 (after NFKC these cannot be grounded). */
const FOREIGN_NUMERAL = /(?![0-9])[\p{Nd}\p{No}]/u;
export const hasForeignNumeral = (s: string): boolean => FOREIGN_NUMERAL.test(normaliseProse(s));

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD = `(?:${[...Object.keys(SMALL), ...Object.keys(TENS), 'hundred', 'thousand'].sort((a, b) => b.length - a.length).join('|')})`;
const PHRASE = new RegExp(`\\b${WORD}\\b(?:(?:\\s+(?:and\\s+)?|-)\\b${WORD}\\b)*`, 'gi');
/** Units and measure nouns: a single number word directly before one of these (one word may sit between) is a number. */
const UNIT = '(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|times?|attempts?|retries|retry|tries|steps?|spans?|errors?|failures?|traces?|requests?|calls?|percent|per\\s*cent|%|users?|seats?|members?|projects?|events?|plans?|tiers?|dollars?|euros?|pounds?)';
const UNIT_AFTER = new RegExp(`^(?:\\s+|-)(?:[a-z]+\\s+)?${UNIT}(?![A-Za-z])`, 'i');
/** Status/position words: a single number word right after one of these is a number ("status five", "step three"). */
const CONTEXT_BEFORE = /\b(?:status|http|code|version|step|span|attempt|error)\s*$/i;
const A_UNIT = /\b(?:a|an)\s+(milliseconds?|minute|hour|day|week|month|year|second(?!\s+[a-z]))\b/gi;
/** Number words this grammar does not parse. In a count/duration/status/percent sentence they make it ungrounded. */
const UNPARSED_NUMBER = new RegExp(`\\b(?:${[...Object.keys(SMALL).filter(w => w !== 'one'), ...Object.keys(TENS), 'hundred', 'thousand'].join('|')}|dozens?|hundreds|thousands|millions?|billions?|trillions?|half|quarter|couple|double|triple|quadruple|once)\\b`, 'i');
const MEASURE_CONTEXT = /\d\s*(?:%|ms\b|s\b)|\b(?:times?|attempts?|retries|retry|tries|ms|milliseconds?|seconds?|minutes?|hours?|percent|steps?|spans?|errors?|failures?|status|http|code|requests?|latency|duration|took|days?|users?|seats?)\b/i;

/** Parses a run of number words ("five hundred three", "twenty-five"); null when it is not a well-formed number. */
function parseNumberWords(words: string[]): number | null {
  let total = 0; let current = 0; let last: 'small' | 'teen' | 'tens' | 'hundred' | 'thousand' | null = null;
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w in SMALL) {
      const v = SMALL[w]!;
      if (last === 'small' || last === 'teen' || (last === 'tens' && v >= 10)) return null;
      current += v; last = v >= 10 ? 'teen' : 'small';
    } else if (w in TENS) {
      if (last === 'small' || last === 'teen' || last === 'tens') return null;
      current += TENS[w]!; last = 'tens';
    } else if (w === 'hundred') {
      if (last === 'hundred' || current >= 100) return null;
      current = (current || 1) * 100; last = 'hundred';
    } else if (w === 'thousand') {
      if (last === 'thousand') return null;
      total += (current || 1) * 1000; current = 0; last = 'thousand';
    } else return null;
  }
  return total + current;
}

/**
 * Number words become digits, conservatively: a run of two or more number words ("five hundred three"), one number
 * word before a unit/measure noun ("three times", "one booking step") or after a status/position word ("status five"),
 * "twice"/"thrice" (2/3 times) and "a/an" + time unit ("an hour"). A lone "one" ("which one") is left alone.
 */
export function numberWordsToDigits(text: string): string {
  let out = text.replace(/\btwice\b/gi, '2 times').replace(/\bthrice\b/gi, '3 times').replace(A_UNIT, (_m, unit: string) => `1 ${unit}`);
  out = out.replace(PHRASE, (match, offset: number, whole: string) => {
    const words = match.split(/(?:\s+(?:and\s+)?|-)/).filter(Boolean);
    const value = parseNumberWords(words);
    if (value === null) return match;
    if (words.length >= 2) return String(value);
    const after = whole.slice(offset + match.length);
    const before = whole.slice(0, offset);
    return UNIT_AFTER.test(after) || CONTEXT_BEFORE.test(before) ? String(value) : match;
  });
  return out;
}

/** The checked form of a sentence: NFKC, then number words as digits. */
export const shadowOf = (sentence: string): string => numberWordsToDigits(normaliseProse(sentence));

/** A foreign numeral, or a number word the grammar could not parse inside a count/duration/status/percent sentence. */
export function hasUngroundableNumber(shadow: string): boolean {
  if (FOREIGN_NUMERAL.test(shadow)) return true;
  return MEASURE_CONTEXT.test(shadow) && UNPARSED_NUMBER.test(shadow);
}

const IDENTIFIER = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const toNumber = (s: string): number => Number(s.replace(/,/g, ''));

/** Numbers and identifiers a reply with no read-back evidence may repeat: those in the buyer's words and the saved context. */
export interface Corpus { numbers: Set<number>; identifiers: Set<string>; words: Set<string> }
export function buildCorpus(text: string): Corpus {
  const shadow = shadowOf(text ?? '');
  const identifiers = new Set((shadow.match(IDENTIFIER) ?? []).map(t => t.toLowerCase()));
  const numbers = new Set((shadow.match(NUMBER) ?? []).map(toNumber).filter(Number.isFinite));
  return { numbers, identifiers, words: new Set(shadow.toLowerCase().match(/[a-z0-9]+/g) ?? []) };
}
const EMPTY_CORPUS: Corpus = { numbers: new Set(), identifiers: new Set(), words: new Set() };

/** Every number in the (shadow) sentence appears in the corpus. Identifiers the corpus contains are skipped whole. */
export function numbersGroundedIn(shadow: string, corpus: Corpus): boolean {
  const rest = shadow.replace(IDENTIFIER, tok => (corpus.identifiers.has(tok.toLowerCase()) ? ' ' : tok));
  for (const m of rest.matchAll(NUMBER)) if (!corpus.numbers.has(toNumber(m[0]))) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------------------
const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|INR|CAD|AUD)\b/i;
const PRICE_UNIT = /\d[\d,.]*\s*(?:dollars?|euros?|pounds?|bucks|usd|eur|gbp)\b|\bper\s+(?:month|year|seat|user|mo|yr|team|project)\b|\/\s*(?:mo|month|yr|year|seat|user)\b|\b(?:a|1)\s+(?:month|year)\b|\b(?:monthly|annually|yearly)\b|\bpricing\s+tiers?\b|\b(?:costs?|priced|billed)\b[^.]{0,40}\d/i;
const FREE_OR_NO_CHARGE = /\bno\s+(?:extra|additional|added|hidden)\s+(?:charges?|costs?|fees?)\b|\bat\s+no\s+(?:extra\s+|additional\s+)?cost\b|\bfree\s+of\s+charge\b|\bfor\s+free\b|\bcomplimentary\b|\bwithout\s+(?:any\s+)?(?:extra\s+)?(?:charge|fee)s?\b/i;

/** A sentence that states a price, a billing amount, a pricing tier or "free/no extra charge". Product copy may say "pricing" with no number. */
export function hasPricingClaim(sentence: string): boolean {
  const s = shadowOf(sentence);
  return CURRENCY.test(s) || PRICE_UNIT.test(s) || FREE_OR_NO_CHARGE.test(s);
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans / tiers
// ---------------------------------------------------------------------------------------------------------------------
/** Plan words, global so callers can matchAll them against the plans a cited record actually lists. */
export const PLAN_WORDS = /\b(free|pro|team|enterprise|starter)\b/gi;
const PLAN_NAMES = '(?:free|pro|team|teams|enterprise|starter|business|premium|growth|basic|standard|plus|hobby|developer)';
const NAMED_PLAN = new RegExp(`\\b${PLAN_NAMES}\\s+(?:plans?|tiers?|editions?|subscriptions?|licen[cs]es?|accounts?|versions?|packages?|customers?|only)\\b|\\b${PLAN_NAMES}-only\\b`, 'i');
const BLANKET_PLAN = /\b(?:every|all|any|each|higher|paid|premium|top|lower|other)\s+(?:plans?|tiers?|editions?)\b|\b(?:plans?|tiers?)\s+(?:include|includes|start|starts|differ)\b|\bupgrad(?:e|ed|es|ing)\b|\b(?:included|bundled)\s+(?:in|with)\b/i;
/** "enterprise"/"premium" used as a bare word. A plan claim unless the saved domain/labels/story use that word. */
const BARE_PLAN = /\b(enterprise|premium)\b/gi;
/** A capitalised plan name after a preposition, used as a name ("on Enterprise", "with Pro"), not as an adjective ("the Enterprise checkout"). */
const CAPITAL_PLAN = /\b(?:on|in|with|under|for|to)\s+(?:the\s+)?(?:Pro|Team|Teams|Free|Starter|Business|Enterprise|Premium)\b(?!\s+[a-z])/;
/** A plan word as the subject of a granting verb ("Enterprise includes SSO"): always a plan claim, whatever the domain. */
const PLAN_SUBJECT = new RegExp(`\\b${PLAN_NAMES}\\s+(?:(?:also|now|even|already)\\s+)?(?:includes?|has|have|gives?|offers?|adds?|comes?\\s+with|unlocks?|gets?|provides?|supports?|allows?|lets?|enables?)\\b`, 'i');

/** "every plan", "all plans", "included in", upgrade wording: a claim about WHICH plans have something. */
export function hasBlanketPlanClaim(sentence: string): boolean {
  return BLANKET_PLAN.test(normaliseProse(sentence));
}

// ---------------------------------------------------------------------------------------------------------------------
// Retention / limit numbers
// ---------------------------------------------------------------------------------------------------------------------
// Time/count units that evidence can ground (ms, minutes, %, counts) are NOT here: adapters check those against readback.
const LIMIT_NUMBER = /\b\d[\d,.]*\s*(?:days?|weeks?|months?|years?|[kmgt]b|seats?|users?|members?|projects?|events?|requests?|retention)\b|\b(?:up\s+to|at\s+most|at\s+least|maximum|max|limit(?:ed)?\s+(?:to|of)|quota|cap(?:ped)?\s+(?:at|of)|retention|retained|retains?|retain|keeps?\s+(?:your|traces?|data))\b[^.]{0,40}\d|\d[^.]{0,40}\b(?:retention|quota|rate\s+limit|limit\s+per)\b/i;

/** A retention period, quota or other limit stated as a number (number words included). */
export function hasLimitNumber(sentence: string): boolean {
  return LIMIT_NUMBER.test(shadowOf(sentence));
}

// ---------------------------------------------------------------------------------------------------------------------
// Capability assertions about the product
// ---------------------------------------------------------------------------------------------------------------------
const CLAIM_VERBS = 'can|could|will|would|does|do|offers?|provides?|includes?|supports?|pages?|alerts?|notif(?:y|ies)|retains?|stores?|keeps?|integrates?|sends?|detects?|fix(?:es)?|monitors?|exports?|has|have|gives?|lets?|allows?|enables?|connects?|covers?|ships?|comes|automates?|automatically|blocks?|prevents?|guarantees?|replays?|streams?|handles?|runs?|routes?|posts?|escalates?';
const ADVERBS = 'also|then|just|only|already|even|really|would|will|can|could|still|automatically|natively|directly|always|never|simply|now|soon|typically|usually|generally';
const GENERIC_PRODUCT = "the\\s+(?:platform|product|tool|service|app)|this\\s+(?:platform|product|feature)|(?:the|that)\\s+feature";
const MODAL_ACTION = /\b(?:can|could|will|would)\s+(?:also\s+)?(?:page|notify|alert|send|post|route|export|integrate|retain|store|keep|detect|fix|monitor|replay|block|prevent|escalate|automate|connect)\b/i;
const OTHER_CLAIM = /\bautomatically\b|\b(?:is|are)\s+(?:also\s+)?(?:available|included|supported|offered|bundled)\b|\b(?:offers?|provides?|supports?|integrates?|retains?)\b|\bout\s+of\s+the\s+box\b/i;

/**
 * NEGATIVE/limit wording about THIS demo or Tailor itself ("I can't", "cannot", "not available here", "nothing was
 * changed", "outside this demo"). Only these excuse a capability word in the same clause. Positive demo-scoped wording
 * ("In this demo <Product> can page Opsgenie") is never an excuse: it is still a product claim.
 */
const NEGATIVE_SCOPE = /\b(?:i|we|tailor|this\s+demo|the\s+demo)\s+(?:(?:really|just|simply|still)\s+)?(?:can(?:['’]t|not)|cannot|won['’]t|will\s+not|(?:am|is|are)\s+(?:not\s+able|unable)|['’]m\s+unable|(?:do|does)\s+not|don['’]t|doesn['’]t|(?:do|does)n['’]t\s+have)\b|\bnot\s+(?:available|supported|possible|shown|something\s+(?:this|the)\s+demo)\b[^.]{0,30}\b(?:here|in\s+this\s+demo|in\s+the\s+demo)\b|\b(?:isn['’]t|is\s+not|aren['’]t|are\s+not)\s+(?:available|supported|possible|shown)\s+(?:here|in\s+(?:this|the)\s+demo)\b|\bisn['’]t\s+something\s+(?:this|the)\s+demo\b|\bnothing\s+(?:was|has\s+been|is)\s+(?:changed|saved|published|sent)\b|\boutside\s+(?:of\s+)?(?:what\s+)?(?:this|the)\s+demo\b|\bunable\s+to\b/i;

/** The clause states a limit of this demo/Tailor (or that nothing was changed), so a capability word there is not a product claim. */
export function isDemoScoped(clause: string): boolean {
  return NEGATIVE_SCOPE.test(normaliseProse(clause));
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
/** Context for one check. */
export interface ClaimContext {
  /**
   * Saved product context and the buyer's own words (domain, labels, story, buyer turns). A bare plan-like word that
   * appears here is a domain word ("the enterprise checkout"), and numbers that appear here may be repeated.
   */
  corpus?: Corpus;
  /** A clause the caller has already established is evidence about the saved record, not a product capability claim. */
  exemptClause?: (clause: string) => boolean;
}

export interface ClaimRules {
  /** Any plan/tier/edition wording, named or blanket. A bare "enterprise" counts unless the corpus uses that word. */
  hasPlanClaim(sentence: string, context?: ClaimContext): boolean;
  /** The raw capability-assertion patterns, ignoring scope. */
  hasCapabilityAssertion(sentence: string): boolean;
  /**
   * A capability assertion about the product in a clause that does not state a negative limit of this demo. Judged clause
   * by clause, so "<Product> can page PagerDuty, but I can't do that here" is still a claim (the first clause is positive).
   */
  hasCapabilityClaim(sentence: string, context?: ClaimContext): boolean;
  /** Price, plan, capability, limit number, link or ungroundable numeral (checked on the NFKC/number-word shadow). */
  isUngroundedClaim(sentence: string, context?: ClaimContext): boolean;
  /**
   * Refuse/unsupported replies (no read-back evidence): keep only neutral sentences whose numbers appear in the corpus
   * (the buyer's words and saved context). Code fences are de-fenced and their content checked like any sentence.
   */
  stripUngroundedClaims(text: string, context?: ClaimContext): string;
  /**
   * Clarification questions and labels describe the BUYER's workflow, so the generic it/they capability pattern would
   * reject legitimate options. Prices, plans, limit numbers, links, numbers the corpus does not contain and claims whose
   * subject is the product itself are dropped. Returns '' when nothing survives; callers treat that as malformed.
   */
  sanitiseClarificationText(text: string, context?: ClaimContext): string;
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

  const hasPlanClaim = (sentence: string, context: ClaimContext = {}) => {
    const s = shadowOf(sentence);
    if (NAMED_PLAN.test(s) || BLANKET_PLAN.test(s) || PRODUCT_PLAN.test(s) || CAPITAL_PLAN.test(s) || PLAN_SUBJECT.test(s)) return true;
    const words = context.corpus?.words;
    return [...s.matchAll(BARE_PLAN)].some(m => !words?.has(m[1]!.toLowerCase()));
  };
  const hasCapabilityAssertion = (s: string) => SUBJECT_CLAIM.test(s) || MODAL_ACTION.test(s) || OTHER_CLAIM.test(s);
  const hasCapabilityClaim = (sentence: string, context: ClaimContext = {}) => shadowOf(sentence).split(CLAUSE_BREAK)
    .some(clause => hasCapabilityAssertion(clause) && !NEGATIVE_SCOPE.test(clause) && !context.exemptClause?.(clause));
  const isUngroundedClaim = (sentence: string, context: ClaimContext = {}) => {
    const s = shadowOf(sentence);
    return hasUngroundableNumber(s) || hasPricingClaim(s) || hasPlanClaim(s, context) || LIMIT_NUMBER.test(s) || hasCapabilityClaim(s, context) || URL_TEXT.test(s);
  };
  const sentencesOf = (text: string) => splitSentences(defence(normaliseProse(text)).replace(/```/g, ' '));

  return {
    hasPlanClaim, hasCapabilityAssertion, hasCapabilityClaim, isUngroundedClaim,
    stripUngroundedClaims(text, context = {}) {
      if (!text) return '';
      const corpus = context.corpus ?? EMPTY_CORPUS;
      return sentencesOf(text).filter(s => !isUngroundedClaim(s, { ...context, corpus }) && numbersGroundedIn(shadowOf(s), corpus)).join(' ').trim();
    },
    sanitiseClarificationText(text, context = {}) {
      if (!text) return '';
      const corpus = context.corpus ?? EMPTY_CORPUS;
      const isClaim = (sentence: string) => {
        const s = shadowOf(sentence);
        return hasUngroundableNumber(s) || hasPricingClaim(s) || hasPlanClaim(s, { corpus }) || LIMIT_NUMBER.test(s) || URL_TEXT.test(s)
          || !numbersGroundedIn(s, corpus)
          || s.split(CLAUSE_BREAK).some(clause => PRODUCT_NAMED_CLAIM.test(clause) && !NEGATIVE_SCOPE.test(clause));
      };
      return sentencesOf(text).filter(s => !isClaim(s)).join(' ').trim();
    },
    allWordsGroundedIn(sentence, sourceText) {
      const source = shadowOf(sourceText);
      const vocabulary = new Set(tokens(source));
      const stems = new Set([...vocabulary].map(stem));
      const s = shadowOf(sentence);
      if (hasUngroundableNumber(s)) return false;
      for (const t of tokens(s)) {
        if (/^\d+$/.test(t)) { if (!vocabulary.has(t)) return false; continue; }
        if (t.length < 4 || glue.has(t)) continue;
        if (!wordSupported(t, vocabulary, stems)) return false;
      }
      return true;
    },
  };
}
