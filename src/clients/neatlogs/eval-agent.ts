// Bounded local evaluation command. Navigation alone never creates an artifact.
import type { EvaluationCheck, EvaluationQuestion } from './eval-contract.ts';
export interface LocalEvaluationPlan {
  expectedVersion: number;
  name: string;
  traceIds?: string[];
  questions: EvaluationQuestion[];
  checks?: EvaluationCheck[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max;
/** Explicit creation intent; explanatory/configuration-location questions never authorise a write. */
export function wantsLocalEvaluation(text: string): boolean {
  const intent = text.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, ' ');
  const command = /\b(?:create|make|build|save|set up|configure)\b[^.!?]{0,90}\b(?:local |synthetic |saved |personalized |personalised )?(?:evals?|evaluations?|review(?: form| questions?| criteria)?)\b/i;
  return command.test(intent)
    && !/\b(?:do not|don't|dont|never|without|avoid|no need to)\b[^.!?]{0,120}\b(?:create|make|build|save|set up|configure)\b/i.test(text)
    && !/\b(?:how|where|what|can i|should (?:i|we))\b[^.!?]{0,100}\b(?:configure|create|set up|save|make|build)\b/i.test(intent)
    && !/\b(?:hosted|production|real|send|notify|connect)\b/i.test(intent);
}
/** Strict structural input; the local domain service independently validates again against current state. */
export function parseLocalEvaluationPlan(value: unknown): LocalEvaluationPlan | null {
  if (!object(value) || Object.keys(value).some(k => !['expectedVersion','name','traceIds','questions','checks'].includes(k)) || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 || !text(value.name, 120)) return null;
  if (value.traceIds !== undefined && (!Array.isArray(value.traceIds) || !value.traceIds.length || value.traceIds.length > 4 || !value.traceIds.every(v => text(v, 200)))) return null;
  if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 8) return null;
  const questions: EvaluationQuestion[] = [];
  for (const raw of value.questions) {
    if (!object(raw) || Object.keys(raw).some(k => !['key','label','type','required','reviewer','min','max','options'].includes(k)) || !text(raw.key,40) || !/^[a-z][a-z0-9-]{0,39}$/.test(String(raw.key)) || !text(raw.label,160) || raw.reviewer !== 'buyer' || typeof raw.required !== 'boolean' || typeof raw.type !== 'string' || !['rating','yes_no','choice','text'].includes(raw.type)) return null;
    if (raw.type === 'rating' && (!Number.isSafeInteger(raw.min) || !Number.isSafeInteger(raw.max) || Number(raw.min) < 0 || Number(raw.max) > 10 || Number(raw.min) >= Number(raw.max))) return null;
    if (raw.type === 'choice' && (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 6 || !raw.options.every(v => text(v,80)))) return null;
    questions.push(raw as unknown as EvaluationQuestion);
  }
  if (new Set(questions.map(q => q.key)).size !== questions.length) return null;
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || value.checks.length > 8 || value.checks.length < 1) return null;
    for (const check of value.checks) {
      if (!object(check) || !text(check.key,40) || !text(check.label,120) || typeof check.kind !== 'string' || !['no_error','latency','required_output_fields'].includes(check.kind)) return null;
      const allowed = check.kind === 'latency' ? ['key','label','kind','maxDurationMs'] : check.kind === 'required_output_fields' ? ['key','label','kind','fields'] : ['key','label','kind'];
      if (Object.keys(check).some(k => !allowed.includes(k))) return null;
      if (check.kind === 'latency' && (!Number.isFinite(check.maxDurationMs) || Number(check.maxDurationMs) < 1 || Number(check.maxDurationMs) > 600_000)) return null;
      if (check.kind === 'required_output_fields' && (!Array.isArray(check.fields) || !check.fields.length || check.fields.length > 8 || !check.fields.every(v => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(v)))) return null;
    }
  }
  return structuredClone(value) as unknown as LocalEvaluationPlan;
}

export function isResolutionReviewQuestion(text: string): boolean {
  return /(?:^|[.!?]\s*)(?:how|where|what|can|does|which)\b/i.test(text) && /\b(?:measure|evaluate|review|assess|criteria|quality|rubric)\b/i.test(text) && /\b(?:resolv\w*|request|answer|configure|review)\b/i.test(text);
}

export function describeLocalEvaluation(detail: import('./eval-contract.ts').EvaluationDetail): string {
  const e = detail.evaluation;
  const checks = e.checkResults ?? [];
  const passed = checks.filter(check => check.status === 'passed').length;
  const failed = checks.filter(check => check.status === 'failed').length;
  const unavailable = checks.filter(check => check.status === 'unavailable').length;
  const pending = e.questions.filter(q => q.required && q.reviewer === 'buyer').flatMap(q => e.traceIds.filter(id => !e.responses.some(r => r.traceId === id && r.questionKey === q.key && r.source === 'buyer'))).length;
  return `Local review “${e.name}” (review version ${e.version}, trace dataset ${e.datasetVersion}). ${pending} required human judgments remain pending.
Fixed snapshot checks: ${passed} passed, ${failed} failed${unavailable ? `, ${unavailable} unavailable` : ''}. ${checks.map(check => check.explanation).join(' ')}
These checks inspect recorded execution or output shape; they do not prove that the answer resolved the request. No hosted AI evaluator ran.`;
}
