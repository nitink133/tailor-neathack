import { isResolutionReviewQuestion } from './eval-agent.ts';
// The ONE server-side Tailor product agent for the Neatlogs demo: the generic core bound to the Neatlogs adapter.

import type { AgentService, GuidanceSelection, ModelProvider, AgentAction } from './agent-contract.ts';
import { createTailorCore } from '../../tailor/core.ts';
import { neatlogsAdapter } from './adapter.ts';

import { resolveGuidance } from './guidance.ts';
import { validateAgentAction } from './provider.ts';

export { AGENT_LIMITS } from '../../tailor/core.ts';

export function createAgentService(): AgentService {
  const core = createTailorCore(neatlogsAdapter);
  return { async handleTurn(input) {
    let selected: GuidanceSelection[] = [];
    let latestAction: AgentAction | null = null;
    const wrap = (source: ModelProvider): ModelProvider => ({
      ...source,
      async complete(request, signal) {
        selected = [];
        latestAction = null;
        const response = await source.complete(request, signal);
        const action = validateAgentAction(response.action);
        latestAction = action;
        if (action && ['propose', 'explain', 'answer', 'create_local_evaluation', 'read_local_evaluation'].includes(action.type) && 'guidance' in action) selected = action.guidance ?? [];
        // Structured, code-validated selection summary; never export arbitrary proposal
        // payloads, provider prose or hidden reasoning.
        input.telemetry.event('planner_selected', {
          plannerAction: action?.type ?? 'invalid', suggestionCount: selected.length,
          ...(action?.type === 'answer' ? { sourceIds: action.knowledgeIds.filter(id => input.knowledge.get(id)).slice(0, 12).join(',') } : {}),
          ...(action?.type === 'create_local_evaluation' ? {expectedVersion:action.evaluation.expectedVersion,evaluationQuestionCount:action.evaluation.questions.length,evaluationCheckCount:action.evaluation.checks?.length ?? 1} : {}),
          ...(action?.type === 'propose' ? { expectedVersion: action.proposal.expectedVersion, proposalMode: action.proposal.mode,
            proposalTraceCount: action.proposal.traces.length, proposalSpanCount: action.proposal.traces.reduce((n, trace) => n + trace.spans.length, 0) } : {}),
        });
        for (const target of selected) input.telemetry.event('planner_selected', { plannerAction: action!.type, guidanceTarget: target.targetId });
        return response;
      },

    });
    const result = await core.handleTurn({ ...input, provider: wrap(input.provider),
      ...(input.escalationProvider ? { escalationProvider: wrap(input.escalationProvider) } : {}) });
    if (!['answered', 'committed'].includes(result.outcome)) return result;
    if (result.outcome === 'answered' && isResolutionReviewQuestion(input.request.text) && input.session.story) {
      const trace = input.request.openTraceId ? input.session.dataset.traces.find(t => t.id === input.request.openTraceId) : input.session.dataset.traces.find(t => t.scenario === input.session.dataset.activeScenario);
      const saved = trace ? JSON.stringify({input:trace.input,output:trace.output}) : '';
      const message = result.messages.findLast(m => m.role === 'tailor' && m.status === 'note');
      if (message && /warrant/i.test(saved) && /repair|book/i.test(saved)) message.text = `For the saved ${input.session.story.domain} example, ask whether the answer explains the warranty coverage and gives an explicit repair-booking next step, supported by the saved request and lookup. This is a human review criterion, not a completed quality judgment.\n\n${message.text}`.slice(0,2000);
    }
    if (!selected.length) { input.telemetry.event('guidance_selected', { suggestionCount: 0 }); return result; }
    try {
      const current = await input.tools.readSession();
      if (current.id !== input.session.id) return result;
      // An informational answer cannot acquire destinations from a changed dataset.
      if (result.outcome === 'answered' && current.version !== input.session.version) return result;
      if (result.outcome === 'committed' && current.version !== result.evidence?.version) return result;
      // Entry's seed rows are concealed until a personalized workflow is saved.
      // They therefore cannot be offered as currently rendered guidance targets.
      if (!current.story) { input.telemetry.event('guidance_selected', { suggestionCount: 0 }); return result; }
      let evaluationDetail = result.evidence?.evaluationDetail;
      const evaluationRef = result.messages.findLast(m => m.evidence?.evaluation)?.evidence?.evaluation;
      if (!evaluationDetail && evaluationRef && input.tools.readLocalEvaluation) evaluationDetail = (await input.tools.readLocalEvaluation(evaluationRef.id, input.request.openTraceId)) ?? undefined;
      const guidance = resolveGuidance(selected, current, result.outcome === 'committed' ? undefined : input.request.openTraceId, evaluationDetail);
      const message = result.messages.findLast(m => m.role === 'tailor' && ['note','applied'].includes(m.status));
      const answered = latestAction as AgentAction | null;
      const supported = answered?.type !== 'answer' || answered.knowledgeIds.some(id => input.knowledge.get(id)) || !!message?.evidence;
      if (message && supported && guidance.length) message.guidance = guidance;
      input.telemetry.event('guidance_selected', { suggestionCount: message?.guidance?.length ?? 0 });
    } catch { input.telemetry.event('guidance_unavailable', { guidanceReason: 'read_failed' }); }
    return result;
  } };
}
