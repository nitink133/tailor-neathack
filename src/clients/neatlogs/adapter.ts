import { parseLocalEvaluationPlan, wantsLocalEvaluation, describeLocalEvaluation } from './eval-agent.ts';
// The Neatlogs demo adapter: everything the Tailor core needs to act as a product agent for the synthetic trace demo.
// Schemas, context, the permitted tools (publishScenario, explainTrace), readback, grounding and the buyer copy that
// names scenarios and traces. The core in src/tailor/ never sees a trace or span.

import type { ProductAdapter } from '../../tailor/adapter.ts';
import type { ValidationIssue } from '../../tailor/contract.ts';
import { clip } from '../../tailor/text.ts';
import {
  LIMITS,
  type AgentAction, type CapabilityRecord, type EvidenceExplanation, type ReadbackEvidence, type ScenarioProposal, type SessionSnapshot,
  type SessionTools, type TurnRequest, type ValidationProblem,
} from './agent-contract.ts';
import type { Evidence, Story, Trace } from './contracts.ts';
import { buyerWording, composeAnswer } from './answer.ts';
import { PRODUCT_NAMES } from './claims.ts';
import { buildContext, spanKeyOf } from './context.ts';
import { entryPreflight, proposalAlignment } from './entry-policy.ts';
import { citedSpanIds, describeCommit, describeTrace, groundNarrative, qualityDefectNarrative, safeNarrative } from './explain.ts';
import { explanationMessage, EXPLANATION_SYSTEM_PROMPT, PROMPT_VERSION, repairMessage, SYSTEM_PROMPT } from './prompts.ts';
import { validateAgentAction, validateEvidenceExplanation } from './provider.ts';

export interface NeatlogsTypes {
  session: SessionSnapshot;
  request: TurnRequest;
  ports: SessionTools;
  record: CapabilityRecord;
  action: AgentAction;
  explanation: EvidenceExplanation;
  readback: ReadbackEvidence;
  detail: Trace;
  evidence: Evidence;
  story: Story;
}

interface ExplainArgs { traceId?: string; spanIds?: string[] }

const ABOUT_THIS_TRACE = /\b(?:this|the open|the current|that)\s+(?:trace|run)\b/i;
const READ_FAILED = 'I couldn’t read that trace just now, so I won’t describe it from memory. Please try again.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sanitiseStory(story: Story): Story {
  return {
    domain: clip(story.domain, 120),
    summary: clip(story.summary, LIMITS.maxStoryChars),
    assumptions: story.assumptions.slice(0, LIMITS.maxAssumptions).map(a => clip(a, 160)),
  };
}

/** The trace a commit is about: the active scenario's, else the first read back. */
function committedEntry(readback: ReadbackEvidence) {
  return readback.traces.find(t => t.key === readback.activeScenario) ?? readback.traces.find(t => t.id === readback.traceIds[0]) ?? readback.traces[0];
}

/** Maps the Neatlogs AgentAction onto the core's action set. Structural validation stays the strict Neatlogs parser. */
function decodeAction(raw: AgentAction): ReturnType<ProductAdapter<NeatlogsTypes>['decodeAction']> {
  const action = validateAgentAction(raw);
  if (!action) return null;
  switch (action.type) {
    case 'read_local_evaluation': return {kind:'tool',tool:'readLocalEvaluation',args:{},narrative:''};
    case 'create_local_evaluation': return { kind: 'tool', tool: 'createLocalEvaluation', args: action.evaluation, narrative: '' };
    case 'ask': return { kind: 'ask', clarification: action.clarification };
    case 'propose': return { kind: 'tool', tool: 'publishScenario', args: action.proposal, narrative: action.explanation };
    case 'explain': return {
      kind: 'tool', tool: 'explainTrace', narrative: action.text,
      args: { ...(action.traceId !== undefined ? { traceId: action.traceId } : {}), ...(action.spanIds !== undefined ? { spanIds: action.spanIds } : {}) },
      ...(action.spanIds !== undefined ? { cites: action.spanIds } : {}),
    };
    case 'answer': return { kind: 'answer', text: action.text, sourceIds: action.knowledgeIds };
    case 'unsupported': return { kind: 'unsupported', text: action.text, ...(action.capabilityId !== undefined ? { sourceId: action.capabilityId } : {}) };
    case 'refuse': return { kind: 'refuse', text: action.text, reason: action.reason };
  }
}

export const NEATLOGS_ADAPTER_VERSION = 'neatlogs-adapter-2026-10-12.2';
export const neatlogsAdapter: ProductAdapter<NeatlogsTypes> = {
  id: 'neatlogs',
  version: NEATLOGS_ADAPTER_VERSION,
  contractVersion: '2026-10-11.1',
  productNames: PRODUCT_NAMES,
  systemPrompt: SYSTEM_PROMPT,
  promptVersion: PROMPT_VERSION,
  responseSchema: 'agent_action',
  preflight: entryPreflight,
  contextMetrics(value) {
    const context = value as import('./context.ts').AgentContext;
    return { contextBudgetChars: context.selection.budgetChars, contextChars: context.selection.jsonChars,
      contextRecentTurnsKept: context.selection.recentTurnsKept, contextRecentTurnsDropped: context.selection.recentTurnsDropped,
      contextPayloadsDropped: context.selection.payloadsDropped, contextKnowledgeRecordsKept: context.selection.knowledgeRecordsKept };
  },
  buildContext: ({ session, request, history, buyerText, choice, question, records, knowledgeVersion }) => buildContext({
    session, resolved: { effectiveText: buyerText, choice, question, history }, records, knowledgeVersion,
    ...(request.openTraceId ? { openTraceId: request.openTraceId } : {}),
  }),
  repairMessage: (problems: ValidationIssue[]) => repairMessage(problems as ValidationProblem[]),
  decodeAction,
  tools: {
    readLocalEvaluation: {
      mutates: false,
      parseArgs: value => value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length ? {} : null,
      async read(_args, ctx) {
        if (!ctx.ports.readLocalEvaluation) return {state:'unavailable',status:'note',text:'No saved local review reader is available in this adapter.'};
        const detail = await ctx.ports.readLocalEvaluation(undefined, ctx.request.openTraceId);
        if (!detail || detail.stale) return {state:'unavailable',status:'note',text:'There is no current saved local review for this trace. Ask me to create a local evaluation first; I will not describe stale or another trace’s results.'};
        const trace = detail.evaluation.traceSnapshot.find(t => t.id === (ctx.request.openTraceId ?? ctx.session.dataset.traces.find(t => t.scenario === ctx.session.dataset.activeScenario)?.id));
        if (!trace || trace.sessionId !== ctx.session.id) return {state:'unavailable',status:'failed',text:'I could not verify owned snapshot evidence for this review.'};
        return {state:'found',version:ctx.session.version,detail:{...trace,localEvaluation:detail}};
      },
      describe(trace, version) {
        const detail = trace.localEvaluation!;
        return {text:`Independently read the saved ${describeLocalEvaluation(detail)}`,evidence:{version,traceIds:detail.evaluation.traceIds,spanIds:[],evaluation:{id:detail.evaluation.id,version:detail.evaluation.version,datasetVersion:detail.evaluation.datasetVersion}}};
      },
    },
    createLocalEvaluation: {
      mutates: true, successOutcome: 'answered',
      uncertainReply: () => 'The local review may have been saved, but I could not verify its independent readback. Reload Evals and inspect the owned review before relying on its questions or results. I have not confirmed a successful review save.',
      parseArgs: parseLocalEvaluationPlan,
      beforeMutation(_args, ctx) {
        if (!wantsLocalEvaluation(ctx.buyerText)) return { kind: 'refuse', reason: 'real_mutation', text: 'That question does not request a saved review. I can explain the local review controls without creating anything.' };
        if (!ctx.session.story) return { kind: 'ask', clarification: { question: 'Which personalized synthetic workflow should this review assess? Save an example first.',
          choices: [{id:'c1',label:'Build a support-agent example'},{id:'c2',label:'Build a retrieval example'},{id:'c3',label:'Build an extraction example'}], allowFreeText: true } };
        return { kind: 'continue' };
      },
      validate(args, ctx) {
        if (args.expectedVersion !== ctx.session.version) return [{ path: 'evaluation.expectedVersion', code: 'SCHEMA', message: 'The review must use the current saved dataset version.' }];
        if (args.traceIds?.some((id: string) => !ctx.session.dataset.traces.some(t => t.id === id && t.sessionId === ctx.session.id))) return [{ path: 'evaluation.traceIds', code: 'SCHEMA', message: 'Every review trace must belong to this demo.' }];
        const requestedDurations = [...ctx.buyerText.matchAll(/(\d+(?:\.\d+)?)\s*(ms|milliseconds|seconds?|s)\b/gi)].map(match => Number(match[1]) * (/^m/i.test(match[2]!) ? 1 : 1000));
        if (args.checks?.some((check: import('./eval-contract.ts').EvaluationCheck) => check.kind === 'latency' && !requestedDurations.includes(check.maxDurationMs))) return [{ path:'evaluation.checks',code:'SCHEMA',message:'A duration check needs the exact threshold explicitly requested by the buyer.' }];
        if (args.checks?.some((check: import('./eval-contract.ts').EvaluationCheck) => check.kind === 'required_output_fields' && check.fields.some(field => !new RegExp(`\\b${field}\\b`,'i').test(ctx.buyerText)))) return [{ path:'evaluation.checks',code:'SCHEMA',message:'Required-field checks may only use output field names explicitly requested by the buyer.' }];

        return [];
      },
      execute: (args, ctx) => ctx.ports.createLocalEvaluation ? ctx.ports.createLocalEvaluation(args, { clientTurnId: ctx.request.clientTurnId, ...(ctx.request.openTraceId ? {openTraceId:ctx.request.openTraceId} : {}) })
        : Promise.resolve({state:'unsupported',reason:'This adapter has no local review persistence tool.'}),
      echo: args => JSON.stringify({type:'create_local_evaluation',evaluation:args}),
      describe(readback) {
        const e = readback.evaluationDetail?.evaluation;
        if (!e || !readback.evaluation) return {text:'I could not verify a saved local review. Reload before relying on it.'};
        return { text: `Saved and independently read back the ${describeLocalEvaluation(readback.evaluationDetail!)}`,
          evidence: { version: readback.version, traceIds: readback.traceIds, spanIds: readback.spanIds, evaluation: readback.evaluation } };
      },
    },
    publishScenario: {
      mutates: true,
      parseArgs: (args): ScenarioProposal | null => (isObj(args) ? args as unknown as ScenarioProposal : null),
      async beforeMutation(args, ctx) {
        const alignment = proposalAlignment(args as ScenarioProposal, ctx.buyerText);
        if (alignment.kind !== 'continue') return alignment;
        if (!ctx.ports.prepareScenario) return { kind: 'continue' };
        const prepared = await ctx.ports.prepareScenario(args as ScenarioProposal);
        return prepared.state === 'confirmation_required'
          ? { kind: 'ask', reason: 'material_switch', clarification: prepared.confirmation }
          : { kind: 'continue' };
      },
      // No pre-validate: publishScenario validates against current state and returns `rejected` without writing.
      execute: (proposal: ScenarioProposal, ctx) => ctx.ports.publishScenario(proposal),
      echo: (proposal: ScenarioProposal, explanation) => JSON.stringify({ type: 'propose', proposal, explanation }),
      async readDetail(readback, ctx) {
        const traceId = committedEntry(readback)?.id ?? readback.traceIds[0];
        if (!traceId) return null;
        return (await ctx.step('explain', { traceCount: readback.traces.length }, () => ctx.ports.readTrace(traceId), () => 'Read the saved trace'))?.trace ?? null;
      },
      explanation: {
        responseSchema: 'evidence_explanation',
        needsDetail: true,
        messages: ({ buyerText, args, readback, detail }) => [
          { role: 'system', content: EXPLANATION_SYSTEM_PROMPT },
          { role: 'user', content: explanationMessage({ buyerText, story: (args as ScenarioProposal).story, trace: detail!, readback }) },
        ],
        decode: raw => {
          const explanation = validateEvidenceExplanation(raw);
          return explanation ? { text: explanation.text, cites: explanation.spanIds } : null;
        },
      },
      describe(readback, trace, narrative, cited) {
        const { text, evidence } = describeCommit(readback, trace, narrative);
        // A model's valid subset cannot erase the source/check observations used by code-owned quality wording.
        const spanIds = trace && qualityDefectNarrative(trace) ? [...new Set([...cited, ...evidence.spanIds])] : cited.length ? cited : evidence.spanIds;
        return { text, evidence: { ...evidence, spanIds } };
      },
      storyOf: (proposal: ScenarioProposal) => sanitiseStory(proposal.story),
    },
    explainTrace: {
      mutates: false,
      parseArgs: (args): ExplainArgs | null => {
        if (!isObj(args)) return null;
        const { traceId, spanIds } = args;
        if (traceId !== undefined && typeof traceId !== 'string') return null;
        if (spanIds !== undefined && !(Array.isArray(spanIds) && spanIds.every(s => typeof s === 'string'))) return null;
        return { ...(traceId !== undefined ? { traceId } : {}), ...(spanIds !== undefined ? { spanIds: spanIds as string[] } : {}) };
      },
      async read(args: ExplainArgs, ctx) {
        // The trace the buyer has open wins over whatever the model named; it is never silently swapped for another one.
        const { session, request } = ctx;
        const openId = request.openTraceId?.trim();
        let targetId: string;
        let spanCount = 0;
        if (openId) {
          targetId = openId;
          spanCount = session.dataset.traces.find(t => t.id === openId)?.spans.length ?? 0;
        } else {
          const wanted = args.traceId?.trim();
          const target = session.dataset.traces.find(t => wanted && (t.id === wanted || t.scenario === wanted))
            ?? session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)
            ?? session.dataset.traces[0];
          if (!target) return { state: 'unavailable', status: 'note', text: 'There’s no scenario to explain yet. Describe the workflow you’re building and I’ll create one first.' };
          targetId = target.id;
          spanCount = target.spans.length;
        }
        const read = await ctx.step('explain', { spanCount }, () => ctx.ports.readTrace(targetId), () => 'Read the saved trace');
        if (!read && openId) return { state: 'unavailable', status: 'failed', text: 'I couldn’t find the trace you have open in this demo, so I won’t describe a different one instead. Reopen it from the trace list and ask again.' };
        if (!read) return { state: 'unavailable', status: 'failed', text: READ_FAILED };
        return { state: 'found', detail: read.trace, version: read.version };
      },
      describe(trace, version, narrative, cited) {
        const required = citedSpanIds(trace);
        const evidence: Evidence = { version, traceIds: [trace.id], spanIds: qualityDefectNarrative(trace) ? [...new Set([...cited, ...required])] : cited.length ? cited : required };
        const description = describeTrace(trace);
        return { text: `${description}${narrative && !description.includes(narrative) ? `\n${narrative}` : ''}`, evidence };
      },
    },
  },
  grounding: {
    ground: (text, readback, trace) => groundNarrative(text, trace, readback),
    safeNarrative: (readback, trace) => safeNarrative(trace, readback),
    citable: (_readback, trace) => (trace ? trace.spans.map(s => s.id) : []),
    normaliseCitation(id, _readback, trace) {
      if (!trace) return null;
      if (trace.spans.some(span => span.id === id)) return id;
      // The planner sees these short keys. Resolve only within the freshly read selected trace;
      // never strip a foreign id's prefix, search other traces, or guess a span from its name.
      const matches = trace.spans.filter(span => spanKeyOf(trace, span) === id);
      return matches.length === 1 ? matches[0]!.id : null;
    },
  },
  composeAnswer,
  recordTitle: record => record.title,
  recordId: record => record.id,
  groundingText: session => [
    session.story?.domain ?? '',
    ...session.dataset.traces.flatMap(t => [t.label, t.name, t.outcome, ...t.tags, ...t.spans.map(s => s.name)]),
  ].join('\n'),
  buyerWording,
  // An uncited "answer" about the trace on screen is really an explanation of THAT trace, read back by code.
  redirectUncitedAnswer: (action, { request, buyerText }) =>
    (request.openTraceId && ABOUT_THIS_TRACE.test(buyerText) ? { kind: 'tool', tool: 'explainTrace', args: {}, narrative: action.text } : null),
  copy: {
    contextLoaded: 'Read the conversation and saved scenario',
    budgetExhausted: 'This demo’s model budget is used up, so I can’t plan new scenarios right now and I haven’t changed anything.',
    rejected: (version, problems) => `I couldn’t make a valid scenario from that, so nothing was saved and version ${version} is still live. What the checks flagged: ${problems || 'the scenario did not pass validation'}. Try rephrasing, or ask for something simpler.`,
    conflict: current => `The scenario changed while I was working (the live version is now ${current}), so nothing was saved and your last good version is still live. Ask again and I’ll start from the latest.`,
    conflictStep: 'The scenario changed meanwhile',
    unsupportedChange: reason => `That isn’t something this demo can show: ${reason}. I didn’t add it to your scenario.`,
    uncertain: lastKnown => `I sent that change, but I couldn’t confirm the result, so I can’t tell you whether it went through. Your next view of the traces will show the version that’s actually live (the last one I could confirm was version ${lastKnown}). Please check the list before asking for another change.`,
    noVerifiedRecord: 'I don’t have a verified record that answers that, so I won’t guess. I can show you a fictional failing workflow or explain the open trace.',
    readFailed: READ_FAILED,
    explainStep: 'Wrote the explanation from the saved trace',
  },
};
