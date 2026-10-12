import { createHash } from 'node:crypto';
import {
  EVALUATION_LIMITS as LIMITS, EVALUATION_SCHEMA_VERSION,
  type EvaluationAggregate, type EvaluationCheck, type EvaluationDetail, type EvaluationQuestion, type EvaluationRepository,
  type EvaluationResponse, type EvaluationService, type EvaluationValue, type StoredEvaluation, type SyntheticEvaluation,
} from './eval-contract.ts';
import type { DemoSession } from './contracts.ts';
import { executeChecks, simulatedResponses, syntheticReviewQuestions } from './eval-fixtures.ts';

export class EvaluationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const invalid = (message: string): never => { throw new EvaluationError(400, 'EVALUATION_INVALID', message); };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!obj(v) || Object.keys(v).some(k => !keys.includes(k))) return invalid('Unexpected evaluation fields.');
  return v;
}
function text(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) return invalid(`${field} must be non-empty text of at most ${max} characters.`);
  return v.trim();
}
function integer(v: unknown, field: string): number {
  if (!Number.isSafeInteger(v) || Number(v) < 1) return invalid(`${field} must be a positive integer.`);
  return Number(v);
}
function operation(v: unknown): string {
  const id = text(v, 96, 'clientOperationId');
  if (!/^[a-zA-Z0-9_-]{8,96}$/.test(id)) return invalid('clientOperationId must be an 8–96 character operation key.');
  return id;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (obj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function assertSession(session: DemoSession, now: Date) {
  if (session.state !== 'active' || Date.parse(session.expiresAt) <= now.getTime()) {
    throw new EvaluationError(410, 'SESSION_EXPIRED', 'This demo has ended or expired.');
  }
}
function datasetVersion(value: unknown, session: DemoSession): number {
  const version = integer(value, 'datasetVersion');
  if (version !== session.version) throw new EvaluationError(409, 'DATASET_CONFLICT', 'The saved traces changed. Reload before creating or reviewing an evaluation.');
  return version;
}
function question(raw: unknown): EvaluationQuestion {
  const q = object(raw, ['key','label','type','required','reviewer','options','min','max']);
  const key = text(q.key, 40, 'Question key');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(key)) return invalid('Question keys must be lower-case slugs.');
  const label = text(q.label, 160, 'Question label');
  if (!['rating','yes_no','choice','text'].includes(String(q.type)) || typeof q.required !== 'boolean' || !['buyer','simulated_judge'].includes(String(q.reviewer))) return invalid('Invalid question type or reviewer.');
  const result: EvaluationQuestion = { key, label, type: q.type as EvaluationQuestion['type'], required: q.required, reviewer: q.reviewer as EvaluationQuestion['reviewer'] };
  if (result.type === 'rating') {
    if (!Number.isSafeInteger(q.min) || !Number.isSafeInteger(q.max) || Number(q.min) < 0 || Number(q.max) > 10 || Number(q.min) >= Number(q.max)) return invalid('Rating bounds must be integers from 0 to 10 with min below max.');
    if (q.options !== undefined) return invalid('Rating questions cannot have choices.');
    result.min = Number(q.min); result.max = Number(q.max);
  } else if (result.type === 'choice') {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 || q.min !== undefined || q.max !== undefined) return invalid('Choice questions need 2–6 options.');
    const options = q.options.map(o => text(o, 80, 'Choice'));
    if (new Set(options).size !== options.length) return invalid('Choices must be distinct.');
    result.options = options;
  } else if (q.options !== undefined || q.min !== undefined || q.max !== undefined) return invalid('This question type has no bounds or choices.');
  return result;
}
function value(q: EvaluationQuestion, v: unknown): EvaluationValue {
  if (q.type === 'rating') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < q.min! || v > q.max!) return invalid(`Answer for ${q.key} is outside its rating range.`);
    return v;
  }
  if (q.type === 'yes_no') { if (typeof v !== 'boolean') return invalid(`Answer for ${q.key} must be yes/no.`); return v; }
  if (q.type === 'choice') { if (typeof v !== 'string' || !q.options!.includes(v)) return invalid(`Answer for ${q.key} must match a choice.`); return v; }
  return text(v, LIMITS.maxTextChars, `Answer for ${q.key}`);
}
function check(raw: unknown): EvaluationCheck {
  if (!obj(raw)) return invalid('Checks must be bounded check objects.');
  const kind = raw.kind;
  const c = object(raw, kind === 'latency' ? ['key','label','kind','maxDurationMs']
    : kind === 'required_output_fields' ? ['key','label','kind','fields'] : ['key','label','kind']);
  const key = text(c.key,40,'Check key');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(key)) return invalid('Check keys must be lower-case slugs.');
  const label = text(c.label,160,'Check label');
  if (kind === 'no_error') return {key,label,kind};
  if (kind === 'latency') {
    const maxDurationMs = integer(c.maxDurationMs,'maxDurationMs');
    if (maxDurationMs > LIMITS.maxDurationMs) return invalid('Latency thresholds must be at most 600000 ms.');
    return {key,label,kind,maxDurationMs};
  }
  if (kind === 'required_output_fields') {
    if (!Array.isArray(c.fields) || !c.fields.length || c.fields.length > LIMITS.maxOutputFields) return invalid('Select 1–8 top-level output fields.');
    const fields = c.fields.map(f => text(f,64,'Output field'));
    if (fields.some(f => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(f) || ['constructor','prototype','__proto__'].includes(f)) || new Set(fields).size !== fields.length) return invalid('Output fields must be distinct simple top-level names.');
    return {key,label,kind,fields};
  }
  return invalid('Unsupported deterministic check kind.');
}
function aggregate(evaluation: SyntheticEvaluation): EvaluationAggregate[] {
  return evaluation.questions.map(q => {
    const responses = evaluation.responses.filter(r => r.questionKey === q.key);
    const numbers = responses.map(r => typeof r.value === 'boolean' ? Number(r.value) : typeof r.value === 'number' ? r.value : null).filter((n): n is number => n !== null);
    const sources = new Set(responses.map(r => r.source));
    return { questionKey: q.key, answeredCount: responses.length, totalCount: evaluation.traceIds.length,
      value: numbers.length ? numbers.reduce((a,b) => a+b,0) / numbers.length : null,
      source: sources.size > 1 ? 'mixed' : [...sources][0] ?? q.reviewer };
  });
}
function finish(evaluation: SyntheticEvaluation): SyntheticEvaluation {
  evaluation.aggregates = aggregate(evaluation);
  evaluation.state = evaluation.traceIds.every(id => evaluation.questions.filter(q => q.required).every(q => evaluation.responses.some(r => r.traceId === id && r.questionKey === q.key))) ? 'completed' : 'pending';
  return evaluation;
}
function detail(stored: StoredEvaluation, session: DemoSession): EvaluationDetail {
  return { evaluation: structuredClone(stored.evaluation), stale: stored.evaluation.datasetVersion !== session.version };
}
function replay(stored: StoredEvaluation, id: string, fingerprint: string): boolean {
  const old = stored.operations.find(o => o.id === id);
  if (!old) return false;
  if (old.fingerprint !== fingerprint) throw new EvaluationError(409, 'IDEMPOTENCY_MISMATCH', 'This operation key was already used for a different evaluation request.');
  return true;
}

/** Pure local domain service. Repository callbacks bind every access to the authorized demo; no hosted API imports. */
export function createEvaluationService(repository: EvaluationRepository, options: { now?: () => Date } = {}): EvaluationService {
  const now = options.now ?? (() => new Date());
  const readStored = (session: DemoSession, id: string) => {
    const stored = repository.read(session.id, id);
    if (!stored) throw new EvaluationError(404, 'EVALUATION_NOT_FOUND', 'Evaluation not found in this demo.');
    return stored;
  };
  return {
    list(session) { assertSession(session, now()); return { datasetVersion: session.version, evaluations: repository.list(session.id).map(e => detail(e,session)) }; },
    read(session, id) { assertSession(session, now()); return detail(readStored(session,id),session); },
    create(session, raw) {
      assertSession(session, now());
      const body = object(raw, ['clientOperationId','datasetVersion','name','description','traceIds','questions','checks']);
      const op = operation(body.clientOperationId), fingerprint = hash(body);
      const id = `eval-${hash([session.id,op]).slice(0,24)}`;
      const existing = repository.read(session.id,id);
      if (existing) { replay(existing,op,fingerprint); return detail(existing,session); }
      const version = datasetVersion(body.datasetVersion,session);
      if (repository.list(session.id).length >= LIMITS.maxEvaluations) throw new EvaluationError(409,'EVALUATION_LIMIT','This demo already has the maximum number of evaluations.');
      const name = text(body.name,120,'Name');
      const description = body.description === undefined || body.description === '' ? '' : text(body.description,LIMITS.maxTextChars,'Description');
      if (!Array.isArray(body.traceIds) || body.traceIds.length < 1 || body.traceIds.length > 4 || body.traceIds.some(id => typeof id !== 'string') || new Set(body.traceIds).size !== body.traceIds.length) return invalid('Select 1–4 distinct saved traces.');
      const traceIds = body.traceIds as string[];
      const traces = traceIds.map(id => { const t = session.dataset.traces.find(t => t.id === id); if (!t) throw new EvaluationError(404,'TRACE_NOT_FOUND','A selected trace is not in this demo.'); return structuredClone(t); });
      const questions = body.questions === undefined ? syntheticReviewQuestions() : (Array.isArray(body.questions) ? body.questions.map(question) : invalid('Questions must be an array.'));
      if (!questions.length || questions.length > LIMITS.maxQuestions || new Set(questions.map(q => q.key)).size !== questions.length) return invalid('Select 1–8 questions with distinct keys.');
      const checks = body.checks === undefined ? undefined : (Array.isArray(body.checks) ? body.checks.map(check) : invalid('Checks must be an array.'));
      if (checks && (!checks.length || checks.length > LIMITS.maxChecks || new Set(checks.map(c => c.key)).size !== checks.length)) return invalid('Select 1–8 checks with distinct keys.');
      const evaluation = finish({ id, schemaVersion: EVALUATION_SCHEMA_VERSION, name, description, version:1, datasetVersion:version,
        mode:'synthetic', provenance:'local_demo', state:'pending', traceIds, traceSnapshot:traces, questions,
        responses:simulatedResponses(traces,questions), aggregates:[],
        ...(checks ? {checks,checkResults:executeChecks(traces,checks)} : {}), createdAt:now().toISOString() });
      const stored: StoredEvaluation = { evaluation, operations:[{id:op,fingerprint}] };
      if (!repository.compareAndSet(session.id,id,null,stored)) {
        const concurrent = readStored(session,id);
        if (replay(concurrent,op,fingerprint)) return detail(concurrent,session);
        throw new EvaluationError(409,'EVALUATION_CONFLICT','The evaluation changed. Reload and try again.');
      }
      return detail(readStored(session,id),session);
    },
    review(session, id, raw) {
      assertSession(session,now());
      const body = object(raw,['clientOperationId','datasetVersion','expectedVersion','responses']);
      const op = operation(body.clientOperationId), fingerprint = hash(body), stored = readStored(session,id);
      if (replay(stored,op,fingerprint)) return detail(stored,session);
      datasetVersion(body.datasetVersion,session);
      if (stored.evaluation.datasetVersion !== session.version) throw new EvaluationError(409,'STALE_EVALUATION','These results belong to an earlier trace snapshot. Create a new evaluation to review current traces.');
      const expectedVersion = integer(body.expectedVersion,'expectedVersion');
      if (expectedVersion !== stored.evaluation.version) throw new EvaluationError(409,'EVALUATION_CONFLICT','The review changed. Reload and try again.');
      if (!Array.isArray(body.responses) || body.responses.length < 1 || body.responses.length > LIMITS.maxResponses) return invalid('Submit 1–32 answers.');
      const seen = new Set<string>();
      const responses: EvaluationResponse[] = body.responses.map(raw => {
        const r = object(raw,['traceId','questionKey','value']);
        if (typeof r.traceId !== 'string' || !stored.evaluation.traceIds.includes(r.traceId)) return invalid('Review trace must belong to this evaluation.');
        const q = stored.evaluation.questions.find(q => q.key === r.questionKey);
        if (!q || q.reviewer !== 'buyer') return invalid('Only questions assigned to you can be reviewed.');
        const key = `${r.traceId}/${q.key}`;
        if (seen.has(key)) return invalid('Submit each answer only once.');
        seen.add(key);
        return { traceId:r.traceId, questionKey:q.key, value:value(q,r.value), source:'buyer', evidenceSpanIds:[] };
      });
      if (stored.operations.length >= LIMITS.maxOperations) throw new EvaluationError(409,'EVALUATION_LIMIT','This evaluation has reached its review limit.');
      const next = structuredClone(stored);
      next.evaluation.responses = [...next.evaluation.responses.filter(r => !seen.has(`${r.traceId}/${r.questionKey}`)),...responses];
      next.evaluation.version++;
      finish(next.evaluation);
      next.operations.push({id:op,fingerprint});
      if (!repository.compareAndSet(session.id,id,expectedVersion,next)) {
        const concurrent = readStored(session,id);
        if (replay(concurrent,op,fingerprint)) return detail(concurrent,session);
        throw new EvaluationError(409,'EVALUATION_CONFLICT','The review changed. Reload and try again.');
      }
      return detail(readStored(session,id),session);
    },
  };
}
