// Explicitly scripted UI preview only. This module is not registered in the provider schema or turn pipeline.
// The caller supplies fresh, authorized browser/demo/evaluation reads; resolution never writes or runs a reviewer.
import type { DemoSession } from './contracts.ts';
import type { BrowserSession } from '../../tailor/demo-contract.ts';
import type { EvaluationService } from './eval-contract.ts';

export const EVAL_PREVIEW_TARGETS = {
  'evals.evaluator': { label: 'Inspect the reviewer setup', purpose: 'See which questions use buyer input or illustrative simulated scores.', tab: 'Overview' },
  'evals.criteria': { label: 'Inspect these criteria', purpose: 'Read the saved review questions and bounded local checks.', tab: 'Questions' },
  'evals.results': { label: 'Inspect saved results', purpose: 'Separate recorded local checks, buyer answers and simulated illustrations.', tab: 'Results' },
} as const;
export type EvaluationPreviewTarget = keyof typeof EVAL_PREVIEW_TARGETS;
export interface EvaluationPreviewContext {
  browserSession: Pick<BrowserSession, 'id' | 'version' | 'activeDemoId' | 'demos'>;
  session: DemoSession;
  selectedEvaluationId: string | null;
  evaluations: Pick<EvaluationService, 'read'>;
}
export interface EvaluationPreviewBinding {
  ownerSessionId: string; ownerVersion: number; demoId: string; datasetVersion: number; scenario: string;
  evaluationId: string; evaluationVersion: number; traceIds: string[];
}
export interface EvaluationPreviewGuide {
  id: string;
  targetId: EvaluationPreviewTarget;
  label: string; purpose: string; tab: 'Overview' | 'Questions' | 'Results';
  binding: EvaluationPreviewBinding;
  provenance: { deterministicChecks: number; buyerResponses: number; simulatedScores: number; pendingBuyerResponses: number };
}
export type EvaluationPreviewRecoveryReason = 'invalid_target' | 'demo_unavailable' | 'evaluation_missing' | 'dataset_changed' | 'evaluation_changed' | 'target_unavailable' | 'invalid_binding';
export type EvaluationPreviewResolution = { state: 'resolved'; guide: EvaluationPreviewGuide }
  | { state: 'recovery'; reason: EvaluationPreviewRecoveryReason; message: string; destination: 'evals.overview' };
const recovery = (reason: EvaluationPreviewRecoveryReason): EvaluationPreviewResolution => ({ state: 'recovery', reason,
  message: 'This saved evaluation target is unavailable or has changed. Return to Evals and select a current saved review.', destination: 'evals.overview' });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Only a known destination name enters from the scripted answer. IDs and copy come from fresh saved reads. */
export function resolveEvaluationPreviewGuidance(selection: unknown, context: EvaluationPreviewContext): EvaluationPreviewResolution {
  if (!object(selection) || Object.keys(selection).length !== 1 || typeof selection.targetId !== 'string' || !Object.hasOwn(EVAL_PREVIEW_TARGETS, selection.targetId)) return recovery('invalid_target');
  const targetId = selection.targetId as EvaluationPreviewTarget;
  const { browserSession: owner, session, selectedEvaluationId, evaluations } = context;
  if (session.state !== 'active' || !positive(session.version) || !positive(owner.version) || !owner.id
    || owner.activeDemoId !== session.id || !owner.demos.some(demo => demo.id === session.id)) return recovery('demo_unavailable');
  if (!selectedEvaluationId) return recovery('evaluation_missing');
  let detail;
  try { detail = evaluations.read(session, selectedEvaluationId); } catch { return recovery('evaluation_missing'); }
  const evaluation = detail.evaluation;
  if (evaluation.id !== selectedEvaluationId || !positive(evaluation.version) || evaluation.mode !== 'synthetic' || evaluation.provenance !== 'local_demo') return recovery('evaluation_missing');
  if (detail.stale || evaluation.datasetVersion !== session.version) return recovery('dataset_changed');
  const traceIds = [...evaluation.traceIds];
  if (!traceIds.length || traceIds.length > 4 || new Set(traceIds).size !== traceIds.length || evaluation.traceSnapshot.length !== traceIds.length
    || traceIds.some(id => !session.dataset.traces.some(trace => trace.id === id && trace.sessionId === session.id)
      || !evaluation.traceSnapshot.some(trace => trace.id === id && trace.sessionId === session.id))) return recovery('invalid_binding');
  const checkResults = evaluation.checkResults ?? [];
  if (checkResults.some(result => result.source !== 'deterministic_check' || result.provenance !== 'local_trace_snapshot' || !traceIds.includes(result.traceId)
    || !evaluation.checks?.some(check => check.key === result.checkKey))
    || evaluation.responses.some(response => !traceIds.includes(response.traceId) || !evaluation.questions.some(question => question.key === response.questionKey && question.reviewer === response.source))) return recovery('invalid_binding');
  const provenance = {
    deterministicChecks: checkResults.length,
    buyerResponses: evaluation.responses.filter(response => response.source === 'buyer').length,
    simulatedScores: evaluation.responses.filter(response => response.source === 'simulated_judge').length,
    pendingBuyerResponses: traceIds.reduce((count, traceId) => count + evaluation.questions.filter(question => question.reviewer === 'buyer'
      && !evaluation.responses.some(response => response.traceId === traceId && response.questionKey === question.key)).length, 0),
  };
  if (targetId === 'evals.results' && provenance.deterministicChecks + provenance.buyerResponses + provenance.simulatedScores === 0) return recovery('target_unavailable');
  if (targetId === 'evals.criteria' && !evaluation.questions.length && !evaluation.checks?.length) return recovery('target_unavailable');
  const binding: EvaluationPreviewBinding = { ownerSessionId: owner.id, ownerVersion: owner.version, demoId: session.id, datasetVersion: session.version,
    scenario: session.dataset.activeScenario, evaluationId: evaluation.id, evaluationVersion: evaluation.version, traceIds };
  return { state: 'resolved', guide: { id: JSON.stringify([targetId, binding]), targetId, ...EVAL_PREVIEW_TARGETS[targetId], binding, provenance } };
}

/** Re-resolve after fresh fetches and before locating a rendered target. A resolved guide is not a shown-target receipt. */
export function revalidateEvaluationPreviewGuidance(value: unknown, context: EvaluationPreviewContext): EvaluationPreviewResolution {
  if (!object(value) || !object(value.binding)) return recovery('invalid_binding');
  const current = resolveEvaluationPreviewGuidance({ targetId: value.targetId }, context);
  if (current.state !== 'resolved') return current;
  if (value.binding.evaluationId !== current.guide.binding.evaluationId || value.binding.evaluationVersion !== current.guide.binding.evaluationVersion) return recovery('evaluation_changed');
  if (value.id !== current.guide.id || JSON.stringify(value.binding) !== JSON.stringify(current.guide.binding)) return recovery('invalid_binding');
  return current; // Fresh code-owned copy, never labels or selectors restored from the old guide.
}

export function createScriptedEvaluationPreviewAnswer(context: EvaluationPreviewContext): {
  mode: 'scripted_preview'; text: string; guidance: EvaluationPreviewGuide[]; recovery: EvaluationPreviewResolution | null;
} {
  const guidance: EvaluationPreviewGuide[] = [];
  let unavailable: EvaluationPreviewResolution | null = null;
  for (const targetId of Object.keys(EVAL_PREVIEW_TARGETS)) {
    const resolved = resolveEvaluationPreviewGuidance({ targetId }, context);
    if (resolved.state === 'resolved') guidance.push(resolved.guide);
    else unavailable ??= resolved;
  }
  return { mode: 'scripted_preview', text: 'SCRIPTED UI PREVIEW: inspect the reviewer setup, criteria and saved results for this local synthetic evaluation. No new evaluation or reviewer call ran.', guidance, recovery: unavailable };
}
