// Deterministic mock provider. NOT a model: a heuristic stand-in that reads the CONTEXT_JSON block and the buyer text
// and returns an AgentAction so the whole agent loop (grounding, budgets, validation, readback) can be exercised
// without network, credentials or a provider SDK. It never reports token usage and never claims to understand more
// than keyword/phrase extraction. Nothing here is specific to one domain: the travel example is a SHAPE reference only.

import {
  CONTRACT_VERSION, FICTIONAL_HOST_PATTERN, LIMITS,
  type AgentAction, type ModelProvider, type ProposedSpan, type ProposedTrace, type ProviderRequest, type ProviderResponse, type ScenarioProposal, type ValidationProblem,
} from './agent-contract.ts';
import type { Json, Story } from './contracts.ts';
import { createOfflineProvider } from '../../tailor/mock-provider.ts';
import type { ActiveTraceDetail, AgentContext, KnowledgeSummary } from './context.ts';
import { parseUserMessage } from './prompts.ts';
import { parseAgentAction } from './provider.ts';
import { classifyOfflinePolicy, explicitWorkflowIdentity, inputFromPolicyRequest } from './entry-policy.ts';
import type { PolicyRequest, PolicyResponse } from '../../tailor/policy.ts';
import { qualityWorkflowProposal } from './eval-fixtures.ts';
import { requestBoundary } from './request-boundaries.ts';

export function createMockProvider(): ModelProvider {
  // Round-trip through the strict parser: the mock is held to the same contract as a live provider.
  const planner = createOfflineProvider<AgentAction>({
    decide: request => {
      const action = decide(request as ProviderRequest);
      if (!['propose', 'explain', 'answer'].includes(action.type)) return action;
      const found = findRequest(request as ProviderRequest);
      if (!found) return action;
      // Explicitly heuristic mock selection, using only rendered-capability targets.
      const text = found.text;
      const targets: import('./agent-contract.ts').GuidanceSelection[] = /slow|latency|duration|timing/i.test(text)
        ? [{ targetId: 'trace.slowest-span' }, { targetId: 'trace.model-call' }]
        : action.type === 'propose'
        ? [{ targetId: 'trace.overview' }, { targetId: 'trace.output' }]
        : action.type === 'explain' ? [{ targetId: 'trace.overview' }, { targetId: 'trace.output' }]
        : /model|span|trace|request|input|output/i.test(text) ? [{ targetId: /model/i.test(text) ? 'trace.model-call' : 'trace.overview' }] : [];
      return { ...action, guidance: targets };
    },
    check: action => parseAgentAction(JSON.stringify(action)),
  });
  return {
    ...planner,
    classifierModel: null,
    async classifyPolicy(request: PolicyRequest): Promise<PolicyResponse> {
      const started = performance.now();
      const input = inputFromPolicyRequest(request);
      const decision = input ? classifyOfflinePolicy(input) : { outcome: 'clarify', reason: 'invalid_classification' } as const;
      return { decision, usage: null, latencyMs: Math.max(0, Math.round(performance.now() - started)), costUsd: 0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const slug = (s: string, max: number) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
const under = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s/)[0] ?? s).trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
function hash(s: string): number { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 9000; return 1000 + h; }

// ---------------------------------------------------------------------------------------------------------------------
// Intent patterns
// ---------------------------------------------------------------------------------------------------------------------
const INJECTION = /ignore (?:all |any |your |the |previous |prior |these |those )*(?:rules|instructions|guidelines)|disregard (?:all |any |your |the |previous )*(?:rules|instructions)|system prompt|developer (?:message|prompt)|jailbreak|(?:publish|push|write|send)\b[^.]{0,30}\b(?:every|all) (?:session|buyer|user)s?|reveal\b[^.]{0,30}\b(?:prompt|api key|secret|credential|cookie)|you are now\b/i;
const CAPABILITY_STRONG = /\b(?:slack|pagerduty|opsgenie|alerts?|alerting|notifications?|replays?|evals?|evaluations?|benchmarks?|production traces?|sso|saml|webhooks?|billing|invoices?)\b/i;
const CAPABILITY_WEAK = /\b(?:integrations?|experiments?|deployments?|dashboards?|detections? rules?)\b/i;
const CAPABILITY_ACTION = /\b(?:set ?up|configure|enable|turn on|connect|integrate|schedule|trigger|install|add|send|create|start)\b/i;
// Verbs that ask the demo to DO a product capability. They only count together with a capability noun, and only for
// request-shaped text (a "what/how/does…" question about replay is a knowledge question, not a request to run one).
const CAPABILITY_ACTION_EXT = /\b(?:replay|re-?run|rerun|run|execute|benchmark|export|import|deploy|sync|schedule)\b/i;
const INFO_QUESTION_START = /^(?:what|how|why|which|who|when|where|does|do|is|are)\b/i;
// Words that make a question about the buyer's OWN workflow rather than the product.
const OWN_WORKFLOW = /\bmy (?:own )?(?:agent|workflow|bot|assistant|app|pipeline|copilot|chatbot)\b|\b(?:simulate|make|create|build|generate|produce|swap|switch|change|add|let|have|set|turn)\b/i;

const EXPLAIN = /\b(?:explain|walk me through|what happened|why (?:did|does|is|was|were|do)|what went wrong|what does this (?:trace |run )?show|summari[sz]e (?:this|the) (?:trace|run))\b/i;
const QUESTION_FORM = /\?\s*$|^(?:what|how|can|could|does|do|is|are|which|will|who|where|when|why)\b/i;
const SCENARIO_VERB = /\b(?:show|make|create|build|building|simulate|generate|add|give|demonstrate|turn|change|let|have|set|build|produce|swap|switch)\b/i;
const KNOWLEDGE_TOPIC = /\b(?:neatlogs|pricing|price|prices|cost|costs|plan|plans|tier|tiers|free|how much|detect|detects|detection|detections|integrat\w*|sdk|retention|privacy|security|support|supports|feature|features|capabilit\w*|trial|licen[cs]e)\b/i;

const NEW_WORKFLOW = /\b(?:i'?m|i am|we'?re|we are)\s+(?:building|developing|working on|running|making|shipping|testing)\b|\b(?:new|different|another|second)\s+(?:workflow|agent|bot|scenario|use case|app|assistant)\b|\bstart over\b|\bfrom scratch\b/i;

type ToolPattern = 'timeout' | 'rate_limit' | 'auth' | 'invalid_data' | 'tool_error';
const TOOL_PATTERNS: [ToolPattern, RegExp][] = [
  ['timeout', /time[ds]?[ -]?out|timeouts?|too slow|hangs?\b|stalls?\b/i],
  ['rate_limit', /rate[- ]?limit\w*|\b429\b|too many requests|throttl\w*/i],
  ['auth', /\b40[13]\b|unauthori[sz]ed|forbidden|auth(?:entication|orization)? (?:fail\w*|error)|expired (?:token|credential)s?|invalid (?:token|credential|api key)s?/i],
  ['invalid_data', /invalid (?:data|response|schema|output|json)|garbage|malformed|bad data|schema (?:mismatch|error|validation)|corrupt\w*|gibberish|unparseable|nonsense/i],
  ['tool_error', /tool (?:error|fail\w*|crash\w*|exception)|\b500\b|internal (?:server )?error|crash\w*|exceptions?\b|errors? out\b/i],
];
const PATTERN_SLUG: Record<ToolPattern, string> = { timeout: 'timeout', rate_limit: 'rate-limit', auth: 'auth-failure', invalid_data: 'invalid-data', tool_error: 'tool-error' };
const PATTERN_LABEL: Record<ToolPattern, string> = { timeout: 'Timeout', rate_limit: 'Rate limit', auth: 'Auth failure', invalid_data: 'Invalid data', tool_error: 'Tool error' };
const PATTERN_FAIL_MS: Record<ToolPattern, number> = { timeout: 1500, rate_limit: 120, auth: 90, invalid_data: 340, tool_error: 260 };
const GUARDRAIL = /\bguardrails?\b|policy (?:check|violation)|\bblock(?:s|ed|ing)?\b|moderation|compliance (?:check|rule)/i;
const SUCCESS_ONLY = /\bhappy path\b|everything works|no (?:failures?|errors?)\b|(?:successful|clean) run\b/i;

const NO_RETRY = /\b(?:no|without) retr(?:y|ies)\b|\bdoesn'?t retry\b|\bnever retr(?:y|ies)\b/i;
const RETRY_MENTION = /\bretr(?:y|ies|ied|ying)\b|second attempt|second try|try again|tries again|another attempt|re-?attempt|back-?off/i;
const RETRY_SUCCEEDS = /\b(?:retry|retries|second attempt|second try|then)\b[^.]{0,30}\b(?:succe(?:ed|eds|ss|ssful|ssfully)|recover(?:s|ed)?|works?|passes|confirms?|goes through)\b|\bsuccessful(?:ly)? (?:retry|second attempt)\b/i;
const RETRY_FAILS_LOOSE = /\b(?:fail(?:s|ed|ing)?|again|too|also|twice|still|exhaust\w*|gives? up)\b/i;
const RETRY_FAILS_STRONG = /\bboth attempts? fail|\bfails? (?:twice|both)|exhaust\w*/i;

const DOMAIN_KIND = '(?:agent|workflow|bot|assistant|pipeline|copilot|chatbot)';
const STOP = new Set(`a an the i i'm im we my our me you your that this it its is are was were be to of and or with then followed by make give want need see like please can could when where which what how show shows showing fail fails failing failure failed times time out timeout timeouts retry retries retried succeeds succeed successful success api tool call calls error errors something anything build building demo scenario trace traces example first second attempt attempts guardrail guardrails blocks blocked block invalid data returns return garbage rate limit limited down broken bad wrong one two three again too both step steps run runs also but so just some any for in on at as from into where while because since after before between about over using use used where who whom how still new`.split(/\s+/));
const TOOL_STOP = new Set(['the', 'a', 'an', 'my', 'our', 'that', 'this', 'first', 'second', 'retry', 'next', 'each', 'external', 'tool', 'same', 'any', 'one', 'your', 'its', 'another', 'other', 'and', 'or', 'with', 'if', 'when']);

function extractDomain(text: string): { domain: string; raw: string } | null {
  const explicit = explicitWorkflowIdentity(text);
  if (explicit) return explicit;
  const t = norm(text);
  const patterns = [
    new RegExp(`\\b(?:i'?m|i am|we'?re|we are|i've|my team is)\\s+(?:building|developing|working on|running|shipping|testing|making)\\s+(?:an?|the|my|our)?\\s*([a-z0-9][a-z0-9 \\-/&]{1,60}?)\\s+(${DOMAIN_KIND})\\b`, 'i'),
    new RegExp(`\\b(?:for|about|in|on)\\s+(?:an?|the|my|our)\\s+([a-z0-9][a-z0-9 \\-]{1,40}?)\\s+(${DOMAIN_KIND})\\b`, 'i'),
    new RegExp(`\\b(?:my|our|an?|the)\\s+([a-z0-9][a-z0-9\\-]*(?: [a-z0-9\\-]+){0,3}?)\\s+(${DOMAIN_KIND})\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m || !m[1] || !m[2]) continue;
    const words = m[1].trim().split(/\s+/).filter(w => !['new', 'little', 'simple', 'small'].includes(w.toLowerCase()));
    const head = words.slice(-4).join(' ').toLowerCase();
    if (head.length >= 2) return { domain: `${head} ${m[2].toLowerCase()}`, raw: m[0] };
  }
  const words = t.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w) && !/^\d+$/.test(w) && !TOOL_PATTERNS.some(([, re]) => re.test(w)));
  if (words.length >= 2) return { domain: `${words.slice(0, 3).join(' ')} workflow`, raw: '' };
  return null;
}

function extractTool(text: string): string | null {
  const re = /\b([a-z][a-z0-9-]{1,20})\s+(api|tool|service|endpoint|lookup)\b/gi;
  for (const m of norm(text).matchAll(re)) {
    const head = m[1]!.toLowerCase();
    if (TOOL_STOP.has(head)) continue;
    return `${under(head)}_${m[2]!.toLowerCase()}`;
  }
  const named = /\b([A-Z][A-Z0-9_-]{1,15})\s+(?:response|output|returns)\b/.exec(text);
  if (named && !['API', 'JSON', 'HTTP'].includes(named[1]!)) return under(named[1]!);
  return null;
}

function firstToolPattern(text: string): ToolPattern | null {
  let best: { p: ToolPattern; at: number } | null = null;
  for (const [p, re] of TOOL_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { p, at: m.index };
  }
  return best ? best.p : null;
}

interface Spec {
  domain: string | null;
  tool: string | null;
  pattern: ToolPattern | null;
  guardrail: boolean;
  guardrailNoun: string | null;
  retry: 'none' | 'recovers' | 'exhausted' | null;
  attempts: number | null;
  successOnly: boolean;
}

function parseSpec(text: string): { spec: Spec; domainRaw: string } {
  const t = norm(text);
  const dom = extractDomain(t);
  const pattern = firstToolPattern(t);
  const guardrail = GUARDRAIL.test(t);
  const retryMention = RETRY_MENTION.test(t);
  let retry: Spec['retry'] = null;
  if (NO_RETRY.test(t)) retry = 'none';
  else if (RETRY_SUCCEEDS.test(t)) retry = 'recovers';
  else if (RETRY_FAILS_STRONG.test(t) || (retryMention && RETRY_FAILS_LOOSE.test(t)) || (pattern && /escalat/i.test(t))) retry = 'exhausted';
  else if (retryMention) retry = 'recovers';
  const n = /\b(two|2|three|3|four|4)\s+(attempts|tries|retries)\b/i.exec(t);
  const count = n ? ({ two: 2, '2': 2, three: 3, '3': 3, four: 4, '4': 4 } as Record<string, number>)[n[1]!.toLowerCase()]! + (n[2]!.toLowerCase() === 'retries' ? 1 : 0) : null;
  const noun = /\bblock(?:s|ed|ing)?\s+(?:the |a |an |that |this |any )?([a-z][a-z-]{2,20})/i.exec(t)?.[1]?.toLowerCase() ?? null;
  return {
    domainRaw: dom?.raw ?? '',
    spec: {
      domain: dom?.domain ?? null, tool: extractTool(t), pattern, guardrail, guardrailNoun: noun && !['it', 'the', 'and', 'them'].includes(noun) ? noun : null,
      retry: guardrail && !pattern ? 'none' : retry, attempts: count ? Math.min(count, 3) : null, successOnly: SUCCESS_ONLY.test(t) && !pattern && !guardrail,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Context access (the context is built by our own code, but stay defensive: it crosses a JSON boundary)
// ---------------------------------------------------------------------------------------------------------------------
function findRequest(request: ProviderRequest): { context: AgentContext; text: string } | null {
  for (const m of request.messages) {
    if (m.role !== 'user') continue;
    const parsed = parseUserMessage(m.content);
    if (parsed) return { context: parsed.context, text: parsed.buyerText };
  }
  return null;
}

const levelOf = (k: KnowledgeSummary) => k.demonstrationLevel;

// ---------------------------------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------------------------------
function decide(request: ProviderRequest): AgentAction {
  const found = findRequest(request);
  if (!found) return { type: 'unsupported', text: 'I could not read the request context, so I did not change anything.' };
  const { context: ctx, text: raw } = found;
  if (request.repairOf && request.repairOf.length) return repairAction(request, request.repairOf);
  const text = norm(raw);
  const lower = text.toLowerCase();

  const classification = classifyOfflinePolicy({
    remit: '', capabilities: '', latestText: text,
    session: { hasPublishedState: ctx.story !== null, pendingClarification: ctx.unresolvedQuestion ? { question: ctx.unresolvedQuestion.question, choices: ctx.unresolvedQuestion.choices.map(c => c.label) } : null, resolvedChoice: ctx.choiceResolved?.label ?? null },
  });

  const refusal = refusalFor(text);
  if (refusal) return refusal;

  const { spec, domainRaw } = parseSpec(text);
  const withoutDomain = domainRaw ? text.replace(domainRaw, ' ') : text;
  if (/\b(?:create|build|make|start|run)\b[^.]{0,50}\b(?:evaluation|eval|review)\b/i.test(text) && !NEW_WORKFLOW.test(text)) {
    return { type: 'unsupported', capabilityId: 'synthetic-evaluation-review', text: 'Use the local Evals page to create a review form and save buyer answers or explicitly simulated scores. I can explain those controls here; a hosted AI evaluator is not running.' };
  }
  const qualityKind = /\b(?:retriev\w*|ground\w*|source|documentation)\b/i.test(text) && /\b(?:absent|invent\w*|unsupported|hallucin\w*|wrong|false|claims?)\b/i.test(text) ? 'retrieval'
    : /\b(?:extract\w*|invoice)\b/i.test(text) && /\b(?:omit\w*|miss\w*|due date|completeness)\b/i.test(text) ? 'extraction'
    : /\b(?:support|customer)\b/i.test(text) && /\b(?:unresolved|doesn't resolve|does not resolve|polite|unhelpful)\b/i.test(text) ? 'support' : null;
  if (qualityKind && classification.outcome === 'allow_demo_action') {
    const proposal = qualityWorkflowProposal(qualityKind, ctx.datasetVersion);
    if (spec.domain) proposal.story.domain = spec.domain;
    return { type: 'propose', proposal, explanation: 'The synthetic run completes without an execution error while its output misses the buyer’s quality requirement.' };
  }

  const asksToDoCapability = CAPABILITY_ACTION.test(withoutDomain) || (!INFO_QUESTION_START.test(text) && CAPABILITY_ACTION_EXT.test(withoutDomain));
  if ((CAPABILITY_STRONG.test(withoutDomain) || CAPABILITY_WEAK.test(withoutDomain)) && asksToDoCapability && !NEW_WORKFLOW.test(text) && !(spec.pattern && !/\b(alert|slack|pagerduty|opsgenie|replay|webhook|sso|saml)\b/i.test(withoutDomain))) {
    const hit = unsupportedFor(withoutDomain, ctx);
    if (hit) return hit;
  }

  if (classification.outcome === 'allow_product_question' && !/\b(?:this|open|saved|current)\s+(?:trace|run)\b/i.test(text)) return answerFor(ctx, text, true);

  if (EXPLAIN.test(text)) {
    if (!ctx.activeTrace) return { type: 'answer', text: 'There is no scenario to explain yet. Describe the workflow you want to see and I will build one first.', knowledgeIds: [] };
    return { type: 'explain', text: explainNarrative(ctx.activeTrace) };
  }

  if (QUESTION_FORM.test(text) && !SCENARIO_VERB.test(lower) && KNOWLEDGE_TOPIC.test(text)) return answerFor(ctx, text);
  // A question-shaped product query beats a scenario verb it merely contains ("…detect failures and show error spans?").
  if (isProductQuestion(ctx, text, spec)) return answerFor(ctx, text, true);

  const newWorkflow = ctx.story === null || NEW_WORKFLOW.test(text) || (/\b(?:switch|change|move)\s+to\b/i.test(text) && explicitWorkflowIdentity(text) !== null);
  const explicit = spec.pattern !== null || spec.guardrail || spec.successOnly;

  if (newWorkflow) {
    if (!explicit && spec.domain === null) return askAction(ctx);
    return propose(ctx, spec, 'new');
  }
  // Follow-up on the existing scenario: the story's domain is kept; only the requested change is applied.
  const followUp: Spec = { ...spec, domain: null };
  if (explicit) return propose(ctx, followUp, 'edit');
  const wantsFail = spec.retry === 'exhausted';
  const wantsSucceed = !wantsFail && (/\b(?:make|let|have)\b[^.]{0,30}\b(?:succe\w*|recover\w*|work|pass)\b/i.test(text) || spec.retry === 'recovers');
  if (wantsFail || wantsSucceed) {
    const edited = ctx.activeTrace ? surgery(ctx, wantsFail ? 'fail' : 'succeed') : null;
    return edited ?? propose(ctx, { ...followUp, retry: wantsFail ? 'exhausted' : 'recovers' }, 'edit');
  }
  return askAction(ctx, true);
}

function refusalFor(text: string): AgentAction | null {
  if (classifyOfflinePolicy({ remit: '', capabilities: '', latestText: text, session: { hasPublishedState: false, pendingClarification: null, resolvedChoice: null } }).outcome === 'deny_instruction_override') return { type: 'refuse', reason: 'injection', text: 'I can’t follow instructions that change how this demo works or reach beyond it, so I haven’t changed anything. I can still build or explain a fictional scenario for you.' };
  const boundary = requestBoundary(text);
  if (boundary) return { type: 'refuse', ...boundary };
  return null;
}

function unsupportedFor(text: string, ctx: AgentContext): AgentAction | null {
  const words = [...new Set([...(text.match(new RegExp(CAPABILITY_STRONG.source, 'gi')) ?? []), ...(text.match(new RegExp(CAPABILITY_WEAK.source, 'gi')) ?? [])].map(w => w.toLowerCase()))];
  const records = (ctx.knowledge ?? []).filter(k => levelOf(k) === 'explain_only' || levelOf(k) === 'unsupported');
  const matches: KnowledgeSummary[] = [];
  for (const w of words) {
    const hit = records.find(k => nameMatches(k, w)) ?? records.find(k => matchesWord(k, w));
    if (hit && !matches.includes(hit)) matches.push(hit);
  }
  const shown = matches.slice(0, 2);
  if (!shown.length && !CAPABILITY_STRONG.test(text)) return null;
  if (shown.length) {
    const say = (k: KnowledgeSummary) => `${k.title} is ${levelOf(k) === 'explain_only' ? 'explain-only in this demo — I can describe it but not run it' : 'not available in this demo'}.`;
    return { type: 'unsupported', capabilityId: shown[0]!.id, text: `${shown.map(say).join(' ')} ${firstSentence(shown[0]!.behaviour)}` };
  }
  return { type: 'unsupported', text: 'That is outside what this demo can do, and I don’t have a verified record describing it, so I won’t guess. I can model a failing workflow or explain the open trace instead.' };
}

const stemOf = (word: string) => word.replace(/(?:ing|s)$/, '');
/** Title/id match is stronger than a topic match ("evals" -> "Human and AI evaluations", not a prompt-management topic). */
function nameMatches(k: KnowledgeSummary, word: string): boolean {
  const stem = stemOf(word);
  return !!stem && [k.id, k.title].some(x => x.toLowerCase().includes(stem));
}

function matchesWord(k: KnowledgeSummary, word: string): boolean {
  if (!word) return false;
  const stem = stemOf(word);
  return [k.id, k.title, ...k.topics].some(x => x.toLowerCase().includes(stem));
}

/**
 * Question-shaped, about the product, not about the buyer's own workflow and not describing a failure to simulate.
 * Product-ness comes from "Neatlogs", the fixed knowledge phrases, or two distinct topic words of the retrieved records.
 */
function isProductQuestion(ctx: AgentContext, text: string, spec: Spec): boolean {
  if (!QUESTION_FORM.test(text)) return false;
  if (OWN_WORKFLOW.test(text) || NEW_WORKFLOW.test(text)) return false;
  if (spec.pattern !== null || spec.guardrail || spec.successOnly || RETRY_MENTION.test(text)) return false;
  if (/\bneatlogs\b/i.test(text) || KNOWLEDGE_TOPIC.test(text)) return true;
  const topics = new Set((ctx.knowledge ?? []).flatMap(k => k.topics.flatMap(t => t.toLowerCase().split(/[^a-z0-9]+/)).filter(t => t.length >= 4)));
  const mine = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length >= 4 && !GENERIC_WORDS.has(w));
  const hits = new Set(mine.filter(w => [...topics].some(t => t === w || t.startsWith(w.slice(0, 5)) && w.length > 4 || w.startsWith(t.slice(0, 5)) && t.length > 4)).map(w => w.slice(0, 5)));
  return hits.size >= 2;
}

const GENERIC_WORDS = new Set(['neatlogs', 'the', 'a', 'an', 'it', 'does', 'do', 'can', 'what', 'how', 'is', 'are', 'for', 'of', 'to', 'in', 'on', 'my', 'me', 'you', 'this', 'that', 'and', 'or', 'with', 'your']);

function answerFor(ctx: AgentContext, text: string, strict = false): AgentAction {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !GENERIC_WORDS.has(w));
  const score = (k: KnowledgeSummary) => words.filter(w => [k.id, k.title, ...k.topics].some(x => x.toLowerCase().split(/[^a-z0-9]+/).some(t => t === w || (w.length > 4 && (t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5)) && t.length > 4))))).length;
  const ranked = (ctx.knowledge ?? []).map((k, i) => ({ k, i, s: score(k) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const picked = ranked.filter(r => r.s > 0).slice(0, 2).map(r => r.k);
  const records = picked.length || strict ? picked : ranked.slice(0, 1).map(r => r.k);
  if (!records.length) return { type: 'answer', text: 'I don’t have a verified record that answers that, so I won’t guess.', knowledgeIds: [] };
  const lines = records.map(k => `${k.title}: ${firstSentence(k.behaviour)}${levelOf(k) === 'explain_only' ? ' (explain-only in this demo.)' : ''}`);
  return { type: 'answer', text: lines.join(' '), knowledgeIds: records.map(k => k.id) };
}

function explainNarrative(trace: ActiveTraceDetail): string {
  const failed = trace.spans.filter(s => s.status === 'ERROR');
  if (!failed.length) return `In plain words: this run completed without a failing step and ended as ${trace.outcome}.`;
  return `In plain words: ${failed.length === 1 ? 'one step' : `${failed.length} steps`} failed (${failed.map(s => s.name).join(', ')}) and the run ended as ${trace.outcome}.`;
}

const CHOICE_POOL: { slug: string; label: string }[] = [
  { slug: 'timeout', label: 'An API call times out, then a retry succeeds' },
  { slug: 'invalid-data', label: 'A tool returns invalid data and the step fails' },
  { slug: 'guardrail', label: 'A guardrail blocks the step and it escalates' },
  { slug: 'rate-limit', label: 'The API rate-limits the call and the retry fails' },
  { slug: 'auth-failure', label: 'A credential is rejected and the agent gives up' },
];

function askAction(ctx: AgentContext, followUp = false): AgentAction {
  const shown = new Set(ctx.dataset.traces.flatMap(t => t.tags));
  const fresh = CHOICE_POOL.filter(c => !shown.has(c.slug));
  const picks = [...fresh, ...CHOICE_POOL.filter(c => shown.has(c.slug))].slice(0, 3);
  const domain = ctx.story?.domain;
  const question = followUp
    ? `I’m not sure what to change${domain ? ` in your ${domain}` : ''}. Which failure should I show?`
    : `Which kind of failure should I show${domain ? ` for your ${domain}` : ''}?`;
  return { type: 'ask', clarification: { question, choices: [
    { id: 'c1', label: picks[0]!.label }, { id: 'c2', label: picks[1]!.label }, { id: 'c3', label: picks[2]!.label },
  ], allowFreeText: true } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------------------------------------------------
function uniqueKey(ctx: AgentContext, key: string): string {
  const taken = new Set(ctx.dataset.traces.map(t => t.key));
  let out = key.slice(0, 40).replace(/-+$/g, '');
  for (let i = 2; taken.has(out); i++) { const suffix = `-${i}`; out = `${key.slice(0, 40 - suffix.length).replace(/-+$/g, '')}${suffix}`; }
  return out;
}

function limitTraces(ctx: AgentContext, mode: 'new' | 'edit'): string[] | undefined {
  if (mode === 'new' || ctx.dataset.traces.length < LIMITS.maxTracesPerDataset) return undefined;
  const drop = ctx.dataset.traces.find(t => t.key !== ctx.activeScenario) ?? ctx.dataset.traces[0];
  return drop ? [drop.key] : undefined;
}

function propose(ctx: AgentContext, spec: Spec, mode: 'new' | 'edit'): AgentAction {
  const inherited = mode === 'edit' ? inheritSpec(ctx) : null;
  const merged: Spec = {
    ...spec,
    domain: spec.domain ?? ctx.story?.domain ?? null,
    tool: spec.tool ?? inherited?.tool ?? null,
    pattern: spec.pattern ?? (spec.guardrail || spec.successOnly ? null : inherited?.pattern ?? null),
  };
  const built = buildScenario(ctx, merged, mode === 'edit' ? ctx.story : null);
  const key = uniqueKey(ctx, built.trace.key);
  const trace = { ...built.trace, key };
  const removeTraceKeys = limitTraces(ctx, mode);
  const story: Story = mode === 'edit' && ctx.story
    ? { domain: ctx.story.domain, summary: clip(`${firstSentence(ctx.story.summary)} Variant: ${built.variant}`, LIMITS.maxStoryChars), assumptions: mergeAssumptions(ctx.story.assumptions, built.assumptions) }
    : { domain: built.domain, summary: clip(built.summary, LIMITS.maxStoryChars), assumptions: built.assumptions.slice(0, LIMITS.maxAssumptions) };
  const proposal: ScenarioProposal = {
    kind: 'scenario_proposal', contractVersion: CONTRACT_VERSION, expectedVersion: ctx.datasetVersion, mode,
    ...(removeTraceKeys ? { removeTraceKeys } : {}), story, activeScenario: key, traces: [trace],
  };
  return { type: 'propose', proposal, explanation: `I modelled “${trace.label}” as a fictional run of your ${story.domain}${mode === 'edit' ? ' and kept your earlier scenario' : ''}.` };
}

function mergeAssumptions(old: string[], added: string[]): string[] {
  const out = [...old];
  for (const a of added) if (!out.includes(a)) out.push(a);
  return out.slice(0, LIMITS.maxAssumptions);
}

function inheritSpec(ctx: AgentContext): { tool: string | null; pattern: ToolPattern | null } {
  const detail = ctx.activeTrace;
  if (!detail) return { tool: null, pattern: null };
  const toolSpan = detail.spans.find(s => s.kind === 'TOOL');
  const tool = toolSpan ? under(toolSpan.name.replace(/^call_/, '').replace(/_attempt_\d+$/, '')) || null : null;
  const err = detail.spans.find(s => s.error)?.error ?? '';
  return { tool, pattern: firstToolPattern(err.replace(/timed out/i, 'timeout')) };
}

function buildScenario(ctx: AgentContext, spec: Spec, story: Story | null): { trace: ProposedTrace; domain: string; summary: string; variant: string; assumptions: string[] } {
  const assumptions: string[] = [];
  const domain = spec.domain ?? story?.domain ?? 'sample workflow';
  if (!spec.domain && !story) assumptions.push('Workflow not described, so this is a generic sample workflow');
  const domainSlug = slug(domain.replace(new RegExp(`\\s+${DOMAIN_KIND}$`, 'i'), ''), 30) || 'sample-workflow';
  const head = under(domainSlug.split('-')[0] ?? 'sample');
  let tool = spec.tool;
  if (!tool) { tool = `${head}_service`; assumptions.push(`The external service is called ${tool.replace(/_/g, ' ')} (my guess)`); }
  const toolHuman = tool.replace(/_/g, ' ');
  let pattern = spec.pattern;
  let retry = spec.retry;
  if (!pattern && !spec.guardrail && !spec.successOnly) {
    pattern = 'timeout';
    retry = retry ?? 'recovers';
    assumptions.push('Failure type was not stated, so I used an API timeout followed by one retry');
  }
  if (pattern && retry === null) retry = 'none';
  const successOnly = spec.successOnly;
  const guardrail = spec.guardrail;
  const noun = spec.guardrailNoun ?? 'request';
  const guardName = `${under(noun)}_guardrail`;
  const host = `api.${domainSlug}.example`;
  const endpoint = `https://${host}/v1/${tool.replace(/_/g, '-')}`;
  const requestId = `SYN-REQ-${hash(domainSlug)}`;
  const rootInput: Json = { synthetic: true, workflow: domain, requestId };

  let failures = 0;
  if (pattern) {
    if (retry === 'exhausted') failures = Math.min(guardrail ? 2 : 3, Math.max(2, spec.attempts ?? 2));
    else if (retry === 'recovers') failures = Math.min(guardrail ? 1 : 2, Math.max(1, (spec.attempts ?? 2) - 1));
    else failures = 1;
  }
  if (pattern && retry === 'recovers' && !spec.attempts && !/retr/i.test(JSON.stringify(ctx.buyerStatements)) && !spec.retry) assumptions.push('One retry with a short back-off');
  else if (pattern && retry === 'recovers' && !spec.attempts) assumptions.push('One retry with a short back-off');
  assumptions.push(`The ${toolHuman} host is fictional: ${host}`);
  assumptions.push('Everything is synthetic; no real customers or systems');

  const kids: ProposedSpan[] = [];
  let t = 2;
  const push = (key: string, name: string, kind: ProposedSpan['kind'], dur: number, status: 'OK' | 'ERROR', input: Json, output: Json, error: string | null, detection: boolean, gapAfter: number) => {
    kids.push({ key, parentKey: 'root', name, kind, startMs: t, durationMs: dur, status, input, output, error, detection });
    t += dur + gapAfter;
  };
  push('validate', 'validate_request', 'GUARDRAIL', 6, 'OK', { workflow: domain, requestId }, { valid: true }, null, false, 2);
  push('plan', 'plan_next_step', 'LLM', 420, 'OK', { intent: `handle ${domain} request`, requestId }, { tool: `call_${tool}`, retries: retry === 'none' ? 0 : failures }, null, false, 10);

  const failText = (n: number, last: boolean) => {
    const base: Record<ToolPattern, string> = {
      timeout: `SYNTHETIC: ${toolHuman} timed out after ${PATTERN_FAIL_MS.timeout} ms (attempt ${n})`,
      rate_limit: `SYNTHETIC: ${toolHuman} returned 429 Too Many Requests (attempt ${n})`,
      auth: `SYNTHETIC: ${toolHuman} returned 401 Unauthorized, credential rejected (attempt ${n})`,
      invalid_data: `SYNTHETIC: ${toolHuman} returned malformed data that failed schema validation (attempt ${n})`,
      tool_error: `SYNTHETIC: ${toolHuman} raised an internal error, HTTP 500 (attempt ${n})`,
    };
    return pattern ? `${base[pattern]}${last && retry === 'exhausted' ? '; retry budget exhausted' : ''}` : '';
  };
  const attemptInput = (n: number): Json => ({ endpoint, attempt: n, ...(pattern === 'timeout' ? { timeoutMs: PATTERN_FAIL_MS.timeout } : {}) });
  let attempts = 0;
  const failBlocksEnd = (retry === 'exhausted' || retry === 'none') && !guardrail;
  if (pattern) {
    for (let i = 1; i <= failures; i++) {
      attempts = i;
      const lastFailure = i === failures;
      const detection = lastFailure && (retry === 'exhausted' || retry === 'none') && !guardrail;
      push(`attempt-${i}`, `call_${tool}_attempt_${i}`, 'TOOL', PATTERN_FAIL_MS[pattern], 'ERROR', attemptInput(i), null, failText(i, lastFailure), detection, 5);
      if (!lastFailure || retry === 'recovers') push(`backoff-${i}`, 'retry_backoff', 'CHAIN', pattern === 'rate_limit' ? 1000 : 250, 'OK', { attempt: i, backoffMs: pattern === 'rate_limit' ? 1000 : 250 }, { waited: true }, null, false, 5);
    }
    if (retry === 'recovers') {
      attempts = failures + 1;
      push(`attempt-${attempts}`, `call_${tool}_attempt_${attempts}`, 'TOOL', 610, 'OK', attemptInput(attempts), { status: 'ok', synthetic: true }, null, false, 5);
    }
  } else {
    attempts = 1;
    push('attempt-1', `call_${tool}_attempt_1`, 'TOOL', 610, 'OK', attemptInput(1), { status: 'ok', synthetic: true }, null, false, 5);
  }
  if (guardrail) {
    push('policy', guardName, 'GUARDRAIL', 12, 'ERROR', { subject: noun, requestId }, null, `SYNTHETIC: guardrail blocked the ${noun}: policy check failed`, true, 5);
  }

  const reason = pattern ? `${under(PATTERN_SLUG[pattern])}${retry === 'exhausted' ? '_exhausted' : ''}` : 'guardrail_blocked';
  let outcome: string; let outcomeKind: ProposedTrace['outcomeKind']; let output: Json; let finalName: string; let finalInput: Json; let label: string; let keyBase: string; let variant: string; let summaryTail: string;
  const PL = pattern ? PATTERN_LABEL[pattern] : '';
  const P = pattern ? PATTERN_SLUG[pattern] : '';
  if (guardrail) {
    outcome = 'blocked_for_review'; outcomeKind = 'escalation';
    output = { outcome, blocked: noun, reason: 'guardrail_blocked', attempts, handoff: 'fictional human reviewer', synthetic: true };
    finalName = 'escalate_to_human_review'; finalInput = { reason: 'guardrail_blocked', subject: noun };
    label = pattern ? `${PL}, guardrail blocks` : `Guardrail blocks the ${noun}`;
    keyBase = pattern ? `${P}-guardrail-block` : 'guardrail-block';
    variant = `the ${noun} is blocked by a guardrail and sent to a fictional human reviewer.`;
    summaryTail = `${pattern ? `The ${toolHuman} misbehaves (${PL.toLowerCase()}) and a` : 'A'} guardrail blocks the ${noun}; the agent hands it to a fictional human reviewer instead of acting.`;
  } else if (!pattern) {
    outcome = 'completed'; outcomeKind = 'success'; output = { outcome, attempts, synthetic: true };
    finalName = 'prepare_result'; finalInput = { attempts };
    label = 'Successful run'; keyBase = 'happy-path';
    variant = 'every step succeeds.'; summaryTail = `Every step succeeds and the ${domain} finishes normally.`;
  } else if (retry === 'recovers') {
    outcome = 'completed'; outcomeKind = 'success'; output = { outcome, attempts, synthetic: true };
    finalName = 'prepare_result'; finalInput = { attempts };
    label = `${PL}, retry succeeds`; keyBase = `${P}-retry-ok`;
    variant = `the ${toolHuman} fails (${PL.toLowerCase()}), the agent waits and the retry succeeds.`;
    summaryTail = `The first ${toolHuman} call fails (${PL.toLowerCase()}); the agent waits briefly, retries and the retry succeeds.`;
  } else if (retry === 'exhausted') {
    outcome = 'escalation_required'; outcomeKind = 'escalation';
    output = { outcome, reason, attempts, handoff: 'fictional human reviewer', synthetic: true };
    finalName = 'escalate_to_human_review'; finalInput = { reason, attempts };
    label = `${PL}, retry fails, escalate`; keyBase = `${P}-retry-fails`;
    variant = `the retry also fails, so the agent stops and escalates to a fictional human reviewer.`;
    summaryTail = `The ${toolHuman} fails (${PL.toLowerCase()}) and so does the retry; the agent stops retrying and escalates to a fictional human reviewer.`;
    assumptions.push('Escalation creates no real ticket');
  } else {
    outcome = 'request_failed'; outcomeKind = 'failure';
    output = { outcome, reason, attempts, synthetic: true };
    finalName = 'prepare_failure_response'; finalInput = { reason };
    label = `${PL}, no retry`; keyBase = `${P}-no-retry`;
    variant = `the ${toolHuman} fails (${PL.toLowerCase()}) and the agent does not retry.`;
    summaryTail = `The ${toolHuman} fails (${PL.toLowerCase()}) and the agent gives up without retrying.`;
  }
  if (guardrail || failBlocksEnd) assumptions.push('Detections are shown on the step where the run gave up');
  push('final', finalName, 'CHAIN', guardrail || retry === 'exhausted' ? 55 : 40, 'OK', finalInput, output, null, false, 0);

  const root: ProposedSpan = { key: 'root', parentKey: null, name: `SYNTHETIC ${domainSlug} request`, kind: 'WORKFLOW', startMs: 0, durationMs: t + 5, status: 'OK', input: rootInput, output, error: null, detection: false };
  const tags = [...new Set(['synthetic', 'tailor-demo', domainSlug, ...(pattern ? [P] : []), ...(retry && retry !== 'none' && pattern ? ['retry'] : []), ...(guardrail ? ['guardrail'] : []), ...(outcomeKind === 'escalation' ? ['escalation'] : [])])]
    .map(x => x.slice(0, LIMITS.maxTagChars)).slice(0, LIMITS.maxTagsPerTrace);
  const trace: ProposedTrace = {
    key: slug(keyBase, 40) || 'scenario', label: clip(label, LIMITS.maxLabelChars), name: clip(`SYNTHETIC ${domainSlug} request`, LIMITS.maxNameChars),
    outcome, outcomeKind, tags, input: rootInput, output, spans: [root, ...kids],
  };
  const uniqueAssumptions = [...new Set(assumptions)].slice(0, LIMITS.maxAssumptions);
  return { trace, domain, summary: `A fictional ${domain}. ${summaryTail}`, variant, assumptions: uniqueAssumptions };
}

// ---------------------------------------------------------------------------------------------------------------------
// Edits that must preserve the existing active trace (names, inputs, timings) and change only what was asked
// ---------------------------------------------------------------------------------------------------------------------
function fromDetail(d: ActiveTraceDetail): ProposedSpan[] {
  const asJson = (v: Json): Json => (v === '[truncated]' ? { note: 'details omitted from context' } : v);
  return d.spans.map(s => ({
    key: s.key, parentKey: s.parentKey, name: s.name, kind: s.kind, startMs: s.startMs, durationMs: s.durationMs, status: s.status,
    input: asJson(s.input), output: asJson(s.output), error: s.error, detection: s.detection,
  }));
}

function failedAgain(previous: string | null, n: number): string {
  let base = previous ?? 'SYNTHETIC: tool call failed';
  if (!/^SYNTHETIC:/.test(base)) base = `SYNTHETIC: ${base}`;
  base = /\(attempt \d+\)/.test(base) ? base.replace(/\(attempt \d+\)/, `(attempt ${n})`) : `${base} (attempt ${n})`;
  return clip(`${base.replace(/; retry budget exhausted$/, '')}; retry budget exhausted`, LIMITS.maxErrorChars);
}

function surgery(ctx: AgentContext, op: 'fail' | 'succeed'): AgentAction | null {
  const d = ctx.activeTrace;
  if (!d || !ctx.story) return null;
  const spans = fromDetail(d);
  const root = spans.find(s => s.parentKey === null);
  if (!root) return null;
  const kids = spans.filter(s => s !== root).sort((a, b) => a.startMs - b.startMs);
  const tools = kids.filter(s => s.kind === 'TOOL');
  const used = new Set(kids.map(k => k.key));
  const freeKey = (k: string) => { let out = k; for (let i = 2; used.has(out); i++) out = `${k}-${i}`; used.add(out); return out; };

  let newKids: ProposedSpan[]; let outcome: string; let outcomeKind: ProposedTrace['outcomeKind']; let label: string; let keyBase: string; let variant: string; let finalOutput: Json;
  const head = (d.label.split(',')[0] ?? d.label).trim();
  if (op === 'fail') {
    let idx = -1;
    tools.forEach((s, i) => { if (s.status === 'OK' && tools.slice(0, i).some(x => x.status === 'ERROR')) idx = i; });
    if (idx < 0) return null;
    const target = tools[idx]!;
    const previous = [...tools.slice(0, idx)].reverse().find(x => x.status === 'ERROR')!;
    const n = idx + 1;
    target.status = 'ERROR'; target.output = null; target.error = failedAgain(previous.error, n); target.detection = true; target.durationMs = previous.durationMs;
    const pattern = firstToolPattern((previous.error ?? '').replace(/timed out/i, 'timeout'));
    const reason = `${pattern ? `${under(PATTERN_SLUG[pattern])}_` : 'retry_'}exhausted`;
    finalOutput = { outcome: 'escalation_required', reason, attempts: n, handoff: 'fictional human reviewer', synthetic: true };
    const keep = kids.filter(k => k.startMs <= target.startMs);
    const escalate: ProposedSpan = {
      key: freeKey('escalate'), parentKey: root.key, name: 'escalate_to_human_review', kind: 'CHAIN', startMs: target.startMs + target.durationMs + 5, durationMs: 55, status: 'OK',
      input: { reason, attempts: n }, output: finalOutput, error: null, detection: false,
    };
    newKids = [...keep, escalate];
    outcome = 'escalation_required'; outcomeKind = 'escalation';
    label = `${head}, retry fails, escalate`; keyBase = d.key.replace(/-(?:retry-ok|ok)$/, '') + '-retry-fails';
    variant = 'the retry also fails, so the agent stops and escalates to a fictional human reviewer.';
  } else {
    if (kids.some(k => k.kind === 'GUARDRAIL' && k.status === 'ERROR')) return null;
    const failed = tools.filter(x => x.status === 'ERROR');
    const target = failed[failed.length - 1];
    if (!target || tools[tools.length - 1] !== target) return null;
    const n = tools.indexOf(target) + 1;
    target.status = 'OK'; target.error = null; target.detection = false; target.output = { status: 'ok', synthetic: true };
    target.durationMs = Math.min(900, Math.max(120, Math.round(target.durationMs * 0.4)));
    finalOutput = { outcome: 'completed', attempts: n, synthetic: true };
    const keep = kids.filter(k => k.startMs <= target.startMs).map(k => ({ ...k, detection: false }));
    const done: ProposedSpan = {
      key: freeKey('final'), parentKey: root.key, name: 'prepare_result', kind: 'CHAIN', startMs: target.startMs + target.durationMs + 5, durationMs: 40, status: 'OK',
      input: { attempts: n }, output: finalOutput, error: null, detection: false,
    };
    newKids = [...keep, done];
    outcome = 'completed'; outcomeKind = 'success';
    label = `${head}, retry succeeds`; keyBase = d.key.replace(/-(?:retry-fails|no-retry|fails|escalate)$/, '') + '-retry-ok';
    variant = 'the retry now succeeds.';
  }
  const last = newKids[newKids.length - 1]!;
  const newRoot: ProposedSpan = { ...root, durationMs: last.startMs + last.durationMs + 5, output: finalOutput };
  const key = uniqueKey(ctx, slug(keyBase, 40) || 'scenario-edit');
  const tags = [...new Set([...d.tags, ...(outcomeKind === 'escalation' ? ['escalation'] : [])])].slice(0, LIMITS.maxTagsPerTrace);
  const trace: ProposedTrace = {
    key, label: clip(label, LIMITS.maxLabelChars), name: d.name, outcome, outcomeKind, tags,
    input: d.input === '[truncated]' ? root.input : d.input, output: finalOutput, spans: [newRoot, ...newKids],
  };
  const removeTraceKeys = limitTraces(ctx, 'edit');
  const proposal: ScenarioProposal = {
    kind: 'scenario_proposal', contractVersion: CONTRACT_VERSION, expectedVersion: ctx.datasetVersion, mode: 'edit',
    ...(removeTraceKeys ? { removeTraceKeys } : {}),
    story: {
      domain: ctx.story.domain,
      summary: clip(`${firstSentence(ctx.story.summary)} In this variant ${variant}`, LIMITS.maxStoryChars),
      assumptions: mergeAssumptions(ctx.story.assumptions, op === 'fail' ? ['Escalation creates no real ticket'] : []),
    },
    activeScenario: key, traces: [trace],
  };
  return { type: 'propose', proposal, explanation: `I kept your earlier run and added “${trace.label}”, changing only the steps that depend on the retry.` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Repair: fix the specific validator problem codes and re-emit the previous proposal
// ---------------------------------------------------------------------------------------------------------------------
function repairAction(request: ProviderRequest, problems: ValidationProblem[]): AgentAction {
  const assistants = request.messages.filter(m => m.role === 'assistant');
  const previous = assistants.length ? parseAgentAction(assistants[assistants.length - 1]!.content) : null;
  if (!previous || previous.type !== 'propose') return { type: 'unsupported', text: 'I could not repair the scenario from the information I have.' };
  const codes = new Set(problems.map(p => p.code));
  const next = structuredClone(previous.proposal);
  for (const trace of next.traces) fixTrace(trace, codes);
  if (!next.traces.some(t => t.key === next.activeScenario)) next.activeScenario = next.traces[0]!.key;
  next.story.summary = clip(next.story.summary, LIMITS.maxStoryChars);
  next.story.assumptions = next.story.assumptions.slice(0, LIMITS.maxAssumptions);
  return { type: 'propose', proposal: next, explanation: previous.explanation };
}

function fixTrace(trace: ProposedTrace, codes: Set<string>): void {
  trace.label = clip(trace.label, LIMITS.maxLabelChars);
  trace.name = clip(trace.name, LIMITS.maxNameChars);
  trace.tags = [...new Set(trace.tags.map(x => x.slice(0, LIMITS.maxTagChars)))].slice(0, LIMITS.maxTagsPerTrace);
  if (trace.spans.length > LIMITS.maxSpansPerTrace) trace.spans = trace.spans.slice(0, LIMITS.maxSpansPerTrace);
  if (codes.has('ARBITRARY_URL') || codes.has('EXECUTABLE_CONTENT')) {
    let json = JSON.stringify(trace);
    if (codes.has('ARBITRARY_URL')) json = json.replace(/https?:\/\/([^/"\s\\]+)/gi, (m, host: string) => (FICTIONAL_HOST_PATTERN.test(host.split(':')[0]!) ? m : 'https://api.fictional.example'));
    if (codes.has('EXECUTABLE_CONTENT')) json = json.replace(/<\s*script|`|\brequire\s*\(|child_process|rm\s+-rf|\beval\s*\(/gi, '[removed]');
    Object.assign(trace, JSON.parse(json) as ProposedTrace);
  }
  const seen = new Set<string>();
  for (const s of trace.spans) {
    let key = s.key; for (let i = 2; seen.has(key); i++) key = `${s.key}-${i}`;
    s.key = key;
    seen.add(key);
    s.name = clip(s.name, LIMITS.maxNameChars);
    if (s.status === 'ERROR' && s.error === null) s.error = 'SYNTHETIC: step failed';
    if (s.status === 'OK') { s.error = null; s.detection = false; }
    if (s.error !== null) s.error = clip(s.error, LIMITS.maxErrorChars);
  }
  const roots = trace.spans.filter(s => s.parentKey === null);
  if (roots.length === 0 && trace.spans[0]) trace.spans[0].parentKey = null;
  const root = trace.spans.find(s => s.parentKey === null) ?? trace.spans[0]!;
  for (const s of trace.spans) {
    if (s === root) continue;
    const parent = trace.spans.find(p => p.key === s.parentKey);
    if (s.parentKey === null || !parent || reaches(trace, s, s.key)) s.parentKey = root.key;
  }
  // Timing: clamp children into their parent (shrinking durations), then grow the root to contain everything.
  root.startMs = 0;
  const depth = (s: ProposedSpan): number => { let d = 0; let cur: ProposedSpan | undefined = s; const guard = new Set<string>(); while (cur && cur.parentKey !== null && !guard.has(cur.key)) { guard.add(cur.key); cur = trace.spans.find(p => p.key === cur!.parentKey); d++; } return d; };
  for (const s of [...trace.spans].filter(x => x !== root).sort((a, b) => depth(a) - depth(b))) {
    const parent = trace.spans.find(p => p.key === s.parentKey)!;
    const end = parent.startMs + parent.durationMs;
    const original = s.durationMs;
    s.startMs = Math.max(parent.startMs, Math.min(s.startMs, end - 1));
    if (s.startMs + s.durationMs > end) s.durationMs = Math.max(1, end - s.startMs);
    if (s.durationMs <= 0) { s.startMs = parent.startMs; s.durationMs = Math.max(1, Math.min(original, parent.durationMs)); }
  }
  if (codes.has('TIMING')) {
    const latest = Math.max(...trace.spans.map(s => s.startMs + s.durationMs));
    if (latest > root.durationMs) root.durationMs = Math.min(LIMITS.maxRootDurationMs, latest);
  }
  trace.output = root.output;
  const hasError = trace.spans.some(s => s.status === 'ERROR');
  if ((trace.outcomeKind === 'failure' || trace.outcomeKind === 'escalation') && !hasError) trace.outcomeKind = 'success';
}

function reaches(trace: ProposedTrace, from: ProposedSpan, target: string): boolean {
  const guard = new Set<string>();
  let cur: ProposedSpan | undefined = trace.spans.find(p => p.key === from.parentKey);
  while (cur && !guard.has(cur.key)) {
    if (cur.key === target) return true;
    guard.add(cur.key);
    cur = cur.parentKey === null ? undefined : trace.spans.find(p => p.key === cur!.parentKey);
  }
  return false;
}
