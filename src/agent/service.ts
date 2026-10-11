// The ONE server-side Tailor product agent. The model (provider) interprets requests, asks clarifications,
// proposes bounded actions and narrates. CODE enforces budgets, grounding, copy truthfulness and loop termination.
//
//   load_context -> retrieve_knowledge -> model (<=3 calls, <=2 repairs, <=1 escalation)
//   -> act on exactly one AgentAction through SessionTools (<=6 calls) -> grounded reply
//
// Success is only ever claimed from an independent read-back carried by the tool result.

import {
  LIMITS,
  type AgentAction, type AgentService, type AgentTurnInput, type AgentTurnResult, type ExecutionLabel, type ModelProvider, type ProviderMessage,
  type PublishResult, type ScenarioProposal, type SessionTools, type TurnOutcome, type TurnStep, type ValidationProblem,
} from '../agent-contract.ts';
import type { ChatStatus, Clarification, Story, Trace } from '../contracts.ts';
import { buildContext, clip, resolveTurnText } from './context.ts';
import { composeAnswer } from './answer.ts';
import { cleanNarrative, citedSpanIds, describeCommit, describeTrace, groundNarrative } from './explain.ts';
import { repairMessage, SYSTEM_PROMPT, userMessage } from './prompts.ts';
import { validateAgentAction } from './provider.ts';

const MODEL_TIMEOUT_MS = 30_000;

class BudgetError extends Error {}

type TailorMessage = AgentTurnResult['messages'][number];

export function createAgentService(): AgentService {
  return { handleTurn };
}

function guardTools(tools: SessionTools, spend: () => void): SessionTools {
  return {
    readSession: () => { spend(); return tools.readSession(); },
    readTraces: query => { spend(); return tools.readTraces(query); },
    readTrace: id => { spend(); return tools.readTrace(id); },
    publishScenario: proposal => { spend(); return tools.publishScenario(proposal); },
    validateProposal: proposal => { spend(); return tools.validateProposal(proposal); },
  };
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timed out')); }, ms); });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function normaliseClarification(c: Clarification): Clarification | null {
  const question = clip(c.question, 300);
  const labels = c.choices.map(x => clip(x.label.trim(), 80));
  if (!question || labels.some(l => !l)) return null;
  if (new Set(labels.map(l => l.toLowerCase())).size !== 3) return null;
  return { question, choices: [{ id: 'c1', label: labels[0]! }, { id: 'c2', label: labels[1]! }, { id: 'c3', label: labels[2]! }], allowFreeText: true };
}

function sanitiseStory(story: Story): Story {
  return {
    domain: clip(story.domain, 120),
    summary: clip(story.summary, LIMITS.maxStoryChars),
    assumptions: story.assumptions.slice(0, LIMITS.maxAssumptions).map(a => clip(a, 160)),
  };
}

const oneLine = (s: string, n: number) => clip(s.replace(/[\r\n]+/g, ' '), n);

function problemSummary(problems: ValidationProblem[]): string {
  return problems.slice(0, 3).map(p => oneLine(`${p.message || p.code} (${p.code})`, 140)).join('; ');
}

async function handleTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { session, request, knowledge, telemetry, clock, provider } = input;
  const steps: TurnStep[] = [];
  const execution: ExecutionLabel = { mode: provider.mode, provider: provider.name, model: provider.model };
  let providerCalls = 0;
  let repairs = 0;
  let escalations = 0;
  let toolCalls = 0;
  const tools = guardTools(input.tools, () => {
    if (toolCalls >= LIMITS.maxToolCallsPerTurn) throw new BudgetError('Tool call budget exhausted');
    toolCalls++;
  });

  const finish = (outcome: TurnOutcome, message: TailorMessage, extra: Partial<AgentTurnResult> = {}): AgentTurnResult =>
    ({ outcome, messages: [message], steps, execution, ...extra });
  const note = (text: string, status: ChatStatus = 'note', more: Partial<TailorMessage> = {}): TailorMessage => ({ role: 'tailor', text, status, ...more });

  async function step<T>(name: TurnStep['name'], attributes: Record<string, string | number | boolean>, fn: () => Promise<T>, detail?: (value: T) => string | undefined): Promise<T> {
    const started = clock.now();
    try {
      const value = await telemetry.step(name, attributes, fn);
      const d = detail?.(value);
      steps.push({ name, status: 'ok', ...(d ? { detail: d } : {}), durationMs: Math.max(0, clock.now() - started) });
      return value;
    } catch (error) {
      steps.push({ name, status: 'failed', durationMs: Math.max(0, clock.now() - started) });
      throw error;
    }
  }

  try {
    // 1. load_context ------------------------------------------------------------------------------------------------
    const resolved = await step('load_context', { turns: session.conversation.length, version: session.version }, async () => resolveTurnText(session, request),
      r => (r.choice ? 'Used your choice' : 'Read the conversation and saved scenario'));
    // 2. retrieve_knowledge ------------------------------------------------------------------------------------------
    const records = await step('retrieve_knowledge', { max: LIMITS.maxKnowledgeRecordsPerTurn }, async () => knowledge.select(resolved.effectiveText, LIMITS.maxKnowledgeRecordsPerTurn).slice(0, LIMITS.maxKnowledgeRecordsPerTurn),
      r => `${r.length} knowledge ${r.length === 1 ? 'record' : 'records'}`);
    const context = buildContext({ session, resolved, records, knowledgeVersion: knowledge.version });
    const messages: ProviderMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(context, resolved.effectiveText) },
    ];

    // 3. model --------------------------------------------------------------------------------------------------------
    async function callOnce(prov: ModelProvider, name: 'model' | 'repair' | 'escalate', repairOf?: ValidationProblem[]): Promise<AgentAction | null> {
      providerCalls++;
      try {
        const response = await step(name, { provider: prov.name, mode: prov.mode, call: providerCalls }, () =>
          withTimeout(signal => prov.complete({ messages, responseSchema: 'agent_action', maxOutputTokens: LIMITS.maxOutputTokens, ...(repairOf ? { repairOf } : {}) }, signal), MODEL_TIMEOUT_MS),
        name === 'repair' ? () => 'Fixed what the checks flagged' : name === 'escalate' ? () => 'Asked a stronger model once' : () => 'Planned the response');
        telemetry.recordUsage(response.usage, prov.model);
        telemetry.event('provider_latency', { provider: prov.name, latencyMs: response.latencyMs });
        const action = validateAgentAction(response.action);
        if (!action) return null;
        if (action.type === 'ask') {
          const c = normaliseClarification(action.clarification);
          return c ? { type: 'ask', clarification: c } : null;
        }
        return action;
      } catch (error) {
        telemetry.event('provider_error', { provider: prov.name, kind: error instanceof Error ? error.name : 'unknown' });
        return null;
      }
    }
    /** One logical model step: invalid output or a thrown error is retried inside the repair/call budgets. */
    async function acquire(prov: ModelProvider, name: 'model' | 'repair' | 'escalate', repairOf?: ValidationProblem[]): Promise<AgentAction | null> {
      let first = true;
      for (;;) {
        if (providerCalls >= LIMITS.maxProviderCallsPerTurn) return null;
        if (!first) { if (repairs >= LIMITS.maxRepairsPerTurn) return null; repairs++; }
        first = false;
        const action = await callOnce(prov, name, repairOf);
        if (action) return action;
      }
    }

    const action = await acquire(provider, 'model');
    if (!action) {
      return finish('provider_unavailable', note('I couldn’t get a usable answer from my planning step just now, so I haven’t changed anything. Please try again in a moment.', 'failed'));
    }

    // 4. act ----------------------------------------------------------------------------------------------------------
    switch (action.type) {
      case 'ask': return finish('clarification', note(action.clarification.question, 'question', { clarification: action.clarification }), { clarification: action.clarification });
      case 'propose': return await actOnProposal(action.proposal, action.explanation);
      case 'explain': return await actOnExplain(action);
      case 'answer': return actOnAnswer(action);
      case 'unsupported': return actOnUnsupported(action);
      case 'refuse': return finish('refused', note(`${oneLine(cleanNarrative(action.text) || 'I can’t help with that request.', 400)} Nothing was changed.`));
    }

    // ---------------------------------------------------------------------------------------------------------------
    async function actOnProposal(first: ScenarioProposal, firstExplanation: string): Promise<AgentTurnResult> {
      let proposal = first;
      let explanation = firstExplanation;
      let problems: ValidationProblem[] = [];
      let lastVersion = session.version;
      for (;;) {
        const started = clock.now();
        let result: PublishResult;
        try { result = await tools.publishScenario(proposal); }
        catch (error) {
          if (error instanceof BudgetError) {
            return finish('rejected', note(`I ran out of steps for this message before I could save anything. Version ${lastVersion} is still live.`, 'failed'));
          }
          telemetry.event('publish_threw', { kind: error instanceof Error ? error.name : 'unknown' });
          steps.push({ name: 'save', status: 'failed', detail: 'No confirmation received' }, { name: 'readback', status: 'failed' });
          return finish('readback_uncertain', note(uncertainCopy(session.version), 'uncertain'));
        }
        const durationMs = Math.max(0, clock.now() - started);
        recordPublishSteps(result, durationMs);

        if (result.state === 'rejected') {
          problems = result.problems; lastVersion = result.version;
          // Budgets: repairs are bounded; escalation (one strong-model attempt) replaces the last repair after a failed repair.
          if (repairs >= LIMITS.maxRepairsPerTurn || providerCalls >= LIMITS.maxProviderCallsPerTurn) return rejected(problems, lastVersion);
          repairs++;
          const escalate = input.escalationProvider && escalations < LIMITS.maxEscalationsPerTurn && repairs > 1;
          if (escalate) escalations++;
          messages.push({ role: 'assistant', content: JSON.stringify({ type: 'propose', proposal, explanation }) }, { role: 'user', content: repairMessage(problems) });
          const next = await acquire(escalate ? input.escalationProvider! : provider, escalate ? 'escalate' : 'repair', problems);
          if (!next || next.type !== 'propose') return rejected(problems, lastVersion);
          proposal = next.proposal; explanation = next.explanation;
          continue;
        }
        return await conclude(result, proposal, explanation);
      }
    }

    function recordPublishSteps(result: PublishResult, durationMs: number): void {
      switch (result.state) {
        case 'committed':
          steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'ok', durationMs }, { name: 'readback', status: 'ok' }); break;
        case 'rejected':
          steps.push({ name: 'validate', status: 'failed', detail: problemSummary(result.problems), durationMs }, { name: 'save', status: 'skipped' }, { name: 'readback', status: 'skipped' }); break;
        case 'conflict':
          steps.push({ name: 'save', status: 'failed', detail: 'The scenario changed meanwhile', durationMs }, { name: 'readback', status: 'skipped' }); break;
        case 'save_failed':
          steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'failed', durationMs }, { name: 'readback', status: 'skipped' }); break;
        case 'readback_uncertain':
          steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'failed', detail: 'No confirmation received', durationMs }, { name: 'readback', status: 'failed' }); break;
        case 'expired':
        case 'unsupported':
          steps.push({ name: 'save', status: 'skipped', durationMs }); break;
      }
    }

    function rejected(why: ValidationProblem[], version: number): AgentTurnResult {
      return finish('rejected', note(
        `I couldn’t make a valid scenario from that, so nothing was saved and version ${version} is still live. What the checks flagged: ${problemSummary(why) || 'the scenario did not pass validation'}. Try rephrasing, or ask for something simpler.`, 'failed'));
    }

    async function conclude(result: Exclude<PublishResult, { state: 'rejected' }>, proposal: ScenarioProposal, explanation: string): Promise<AgentTurnResult> {
      switch (result.state) {
        case 'committed': {
          const readback = result.readback;
          const entry = readback.traces.find(t => t.key === readback.activeScenario) ?? readback.traces.find(t => t.id === readback.traceIds[0]) ?? readback.traces[0];
          const traceId = entry?.id ?? readback.traceIds[0];
          let trace: Trace | null = null;
          if (traceId) {
            try { trace = (await step('explain', { traces: readback.traces.length }, () => tools.readTrace(traceId), () => 'Read the saved trace'))?.trace ?? null; }
            catch { trace = null; }
          }
          const { text, evidence } = describeCommit(readback, trace, groundNarrative(explanation, trace, readback));
          return finish('committed', note(text, 'applied', { evidence }), { evidence: readback, story: sanitiseStory(proposal.story) });
        }
        case 'conflict':
          return finish('conflict', note(`The scenario changed while I was working (the live version is now ${result.currentVersion}), so nothing was saved and your last good version is still live. Ask again and I’ll start from the latest.`, 'failed'));
        case 'save_failed':
          return finish('save_failed', note(`I couldn’t save that${result.reason ? ` (${oneLine(result.reason, 120)})` : ''}. Nothing changed: version ${result.version} is still live.`, 'failed'));
        case 'readback_uncertain':
          return finish('readback_uncertain', note(uncertainCopy(result.lastKnownVersion), 'uncertain'));
        case 'expired':
          return finish('expired', note('This demo has ended or expired, so I can no longer read or change anything. Start a new demo to continue.'));
        case 'unsupported':
          return finish('unsupported', note(`That isn’t something this demo can show: ${oneLine(result.reason, 200)}. I didn’t add it to your scenario.`));
      }
    }

    async function actOnExplain(a: Extract<AgentAction, { type: 'explain' }>): Promise<AgentTurnResult> {
      const wanted = a.traceId?.trim();
      const target = session.dataset.traces.find(t => wanted && (t.id === wanted || t.scenario === wanted))
        ?? session.dataset.traces.find(t => t.scenario === session.dataset.activeScenario)
        ?? session.dataset.traces[0];
      if (!target) return finish('answered', note('There’s no scenario to explain yet. Describe the workflow you’re building and I’ll create one first.'));
      let read: { version: number; trace: Trace } | null = null;
      try { read = await step('explain', { spans: target.spans.length }, () => tools.readTrace(target.id), () => 'Read the saved trace'); }
      catch { read = null; }
      if (!read) return finish('answered', note('I couldn’t read that trace just now, so I won’t describe it from memory. Please try again.', 'failed'));
      const narrative = groundNarrative(a.text, read.trace, null);
      const known = new Set(read.trace.spans.map(s => s.id));
      const chosen = (a.spanIds ?? []).filter(id => known.has(id));
      const evidence = { version: read.version, traceIds: [read.trace.id], spanIds: chosen.length ? chosen : citedSpanIds(read.trace) };
      return finish('answered', note(`${describeTrace(read.trace)}${narrative ? `\n${narrative}` : ''}`, 'note', { evidence }));
    }

    function actOnAnswer(a: Extract<AgentAction, { type: 'answer' }>): AgentTurnResult {
      const cited = [...new Set(a.knowledgeIds)].map(id => knowledge.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined).slice(0, LIMITS.maxKnowledgeRecordsPerTurn);
      if (!cited.length) return finish('answered', note('I don’t have a verified record that answers that, so I won’t guess. I can show you a fictional failing workflow or explain the open trace.'));
      // The reply is composed by code from the cited records; provider prose can add at most one filtered lead sentence.
      return finish('answered', note(composeAnswer(cited, resolved.effectiveText, a.text)));
    }

    function actOnUnsupported(a: Extract<AgentAction, { type: 'unsupported' }>): AgentTurnResult {
      const record = a.capabilityId ? knowledge.get(a.capabilityId) : undefined;
      const lead = cleanNarrative(a.text) || (record ? `${record.title} isn’t something this demo can do.` : 'That’s outside what this demo can do.');
      const tail = record ? ` (See: ${record.title}.)` : '';
      return finish('unsupported', note(`${lead}${tail} Nothing was changed.`));
    }
  } catch (error) {
    telemetry.event('agent_error', { kind: error instanceof Error ? error.name : 'unknown' });
    return finish('provider_unavailable', note('Something went wrong on my side before I could finish, so I haven’t changed anything. Please try again.', 'failed'));
  }
}

function uncertainCopy(lastKnown: number): string {
  return `I sent that change, but I couldn’t confirm the result, so I can’t tell you whether it went through. Your next view of the traces will show the version that’s actually live (the last one I could confirm was version ${lastKnown}). Please check the list before asking for another change.`;
}
