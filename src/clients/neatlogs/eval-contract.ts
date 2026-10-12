// Neatlogs-local synthetic evaluations. These shapes confer no hosted API access.
import type { DemoSession, Trace } from './contracts.ts';

export const EVALUATION_SCHEMA_VERSION = '2026-10-12.1' as const;
export const EVALUATION_LIMITS = { maxEvaluations: 8, maxQuestions: 8, maxResponses: 32, maxTextChars: 600, maxOperations: 64, maxChecks: 8, maxOutputFields: 8, maxDurationMs: 600_000 } as const;
/** Fixed local predicates only; never executable expressions or hosted evaluator configuration. */
export type EvaluationCheck = { key: string; label: string } & (
  | { kind: 'no_error' }
  | { kind: 'latency'; maxDurationMs: number }
  | { kind: 'required_output_fields'; fields: string[] }
);
export interface EvaluationCheckResult {
  traceId: string;
  checkKey: string;
  source: 'deterministic_check';
  provenance: 'local_trace_snapshot';
  status: 'passed' | 'failed' | 'unavailable';
  passed: boolean | null;
  evidenceSpanIds: string[];
  /** Exact observations used by the predicate, not an answer-quality judgment. */
  observed: { errorSpanIds?: string[]; elapsedMs?: number; missingFields?: string[] };
  explanation: string;
}
export type EvaluationValue = number | boolean | string;
export interface EvaluationQuestion {
  key: string;
  label: string;
  type: 'rating' | 'yes_no' | 'choice' | 'text';
  required: boolean;
  reviewer: 'buyer' | 'simulated_judge';
  options?: string[];
  min?: number;
  max?: number;
}
export interface EvaluationResponse {
  traceId: string;
  questionKey: string;
  value: EvaluationValue;
  source: 'buyer' | 'simulated_judge';
  evidenceSpanIds: string[];
}
export interface EvaluationAggregate {
  questionKey: string;
  answeredCount: number;
  totalCount: number;
  value: number | null;
  source: 'buyer' | 'simulated_judge' | 'mixed';
}
export interface SyntheticEvaluation {
  id: string;
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  name: string;
  description: string;
  version: number;
  datasetVersion: number;
  mode: 'synthetic';
  provenance: 'local_demo';
  state: 'pending' | 'completed';
  traceIds: string[];
  /** Immutable evidence. Dataset changes mark the evaluation stale rather than redirecting its references. */
  traceSnapshot: Trace[];
  questions: EvaluationQuestion[];
  responses: EvaluationResponse[];
  aggregates: EvaluationAggregate[];
  /** Separate from illustrative judge scores. Absent on older saved evaluations. */
  checks?: EvaluationCheck[];
  checkResults?: EvaluationCheckResult[];
  createdAt: string;
}
export interface EvaluationDetail { evaluation: SyntheticEvaluation; stale: boolean }
export interface EvaluationList { datasetVersion: number; evaluations: EvaluationDetail[] }
export interface CreateEvaluationRequest {
  clientOperationId: string;
  datasetVersion: number;
  name: string;
  description?: string;
  /** Any non-empty subset of this demo's saved traces. */
  traceIds: string[];
  /** Defaults to syntheticReviewQuestions(). */
  questions?: EvaluationQuestion[];
  checks?: EvaluationCheck[];
}
export interface ReviewEvaluationRequest {
  clientOperationId: string;
  datasetVersion: number;
  expectedVersion: number;
  responses: { traceId: string; questionKey: string; value: EvaluationValue }[];
}
/** Private persistence envelope; operation receipts must never enter the public DTO. */
export interface StoredEvaluation {
  evaluation: SyntheticEvaluation;
  operations: { id: string; fingerprint: string }[];
}
export interface EvaluationRepository {
  list(demoId: string): StoredEvaluation[];
  read(demoId: string, evaluationId: string): StoredEvaluation | null;
  /** Atomically write iff stored version matches; null means insert only. Keys are demo-scoped. */
  compareAndSet(demoId: string, evaluationId: string, expectedVersion: number | null, next: StoredEvaluation): boolean;
}
export interface EvaluationService {
  list(session: DemoSession): EvaluationList;
  read(session: DemoSession, evaluationId: string): EvaluationDetail;
  create(session: DemoSession, body: unknown): EvaluationDetail;
  review(session: DemoSession, evaluationId: string, body: unknown): EvaluationDetail;
}
