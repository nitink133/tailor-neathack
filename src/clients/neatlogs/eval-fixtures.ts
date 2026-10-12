import type { EvaluationQuestion, EvaluationResponse } from './eval-contract.ts';
import type { Trace } from './contracts.ts';

/** A mixed review form; "simulated_judge" is deterministic demo data, never an LLM judge. */
export function syntheticReviewQuestions(): EvaluationQuestion[] {
  return [
    { key: 'resolved', label: 'Did the output resolve the fictional request?', type: 'yes_no', required: true, reviewer: 'simulated_judge' },
    { key: 'quality', label: 'How useful and accurate is the answer?', type: 'rating', min: 1, max: 5, required: true, reviewer: 'buyer' },
    { key: 'notes', label: 'What should change?', type: 'text', required: false, reviewer: 'buyer' },
  ];
}

/** Deterministic placeholder verdicts. The caller must retain simulated provenance in every result. */
export function simulatedResponses(traces: Trace[], questions: EvaluationQuestion[]): EvaluationResponse[] {
  return traces.flatMap(trace => questions.filter(q => q.reviewer === 'simulated_judge').map(q => {
    const successful = trace.outcomeKind === 'success';
    const value = q.type === 'yes_no' ? successful
      : q.type === 'rating' ? (successful ? q.max! : q.min!)
      : q.type === 'choice' ? q.options![successful ? 0 : q.options!.length - 1]!
      : `Simulated review: ${trace.label}; fictional outcome ${trace.outcome}. No AI evaluator ran.`;
    return { traceId: trace.id, questionKey: q.key, value, source: 'simulated_judge' as const,
      evidenceSpanIds: trace.spans.filter(s => s.parentId === null || s.status === 'ERROR').map(s => s.id) };
  }));
}
