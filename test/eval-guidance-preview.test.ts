import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore, op } from './helpers/backend.ts';
import { createEvaluationService } from '../src/clients/neatlogs/eval-service.ts';
import { qualityWorkflowProposal } from '../src/clients/neatlogs/eval-fixtures.ts';
import type { StoredEvaluation } from '../src/clients/neatlogs/eval-contract.ts';
import { createScriptedEvaluationPreviewAnswer, resolveEvaluationPreviewGuidance, revalidateEvaluationPreviewGuidance, type EvaluationPreviewContext } from '../src/clients/neatlogs/eval-guidance-preview.ts';

function fixture() {
  const t = tempStore();
  const created = t.store.createOwned(null, 'Fictional invoice extraction review', undefined, op());
  assert.equal(t.store.publish(created.session.id, qualityWorkflowProposal('extraction', 1)).state, 'committed');
  const session = t.store.read(created.session.id);
  const evaluations = createEvaluationService({
    list: id => t.store.listArtifacts<StoredEvaluation>(id, 'evaluations'),
    read: (id, evaluationId) => t.store.readArtifact<StoredEvaluation>(id, 'evaluations', evaluationId),
    compareAndSet: (id, evaluationId, version, next) => t.store.compareAndSetArtifact(id, 'evaluations', evaluationId, version, next),
  }, { now: () => new Date(t.clock.now()) });
  const saved = evaluations.create(session, { clientOperationId: op(), datasetVersion: session.version, name: 'SYNTHETIC required field check',
    traceIds: session.dataset.traces.map(trace => trace.id), checks: [{ key: 'due-date', label: 'Due date present', kind: 'required_output_fields', fields: ['dueDate'] }] });
  const context: EvaluationPreviewContext = { browserSession: t.store.browserSession(created.ownerId), session, selectedEvaluationId: saved.evaluation.id, evaluations };
  return { ...t, context, saved, evaluations };
}

test('scripted preview binds all fixed targets to owned saved evidence without writes or fabricated reviewer execution', () => {
  const f = fixture();
  try {
    const before = f.context.evaluations.read(f.context.session, f.saved.evaluation.id);
    const answer = createScriptedEvaluationPreviewAnswer(f.context);
    assert.equal(answer.mode, 'scripted_preview');
    assert.match(answer.text, /SCRIPTED UI PREVIEW/);
    assert.equal(answer.recovery, null);
    assert.deepEqual(answer.guidance.map(guide => guide.targetId), ['evals.evaluator', 'evals.criteria', 'evals.results']);
    for (const guide of answer.guidance) {
      assert.equal(guide.binding.demoId, f.context.session.id);
      assert.equal(guide.binding.ownerSessionId, f.context.browserSession.id);
      assert.equal(guide.binding.datasetVersion, 2);
      assert.equal(guide.binding.evaluationId, f.saved.evaluation.id);
      assert.equal(guide.binding.evaluationVersion, 1);
      assert.deepEqual(guide.provenance, { deterministicChecks: 1, buyerResponses: 0, simulatedScores: 1, pendingBuyerResponses: 2 });
      assert.equal(revalidateEvaluationPreviewGuidance(JSON.parse(JSON.stringify(guide)), f.context).state, 'resolved');
    }
    assert.equal(before.evaluation.checkResults![0]!.status, 'failed', 'the missing due date remains a real local predicate failure');
    assert.equal(before.evaluation.state, 'pending', 'preview does not fabricate buyer reviews');
    assert.deepEqual(f.context.evaluations.read(f.context.session, f.saved.evaluation.id), before);
    assert.deepEqual(f.store.read(f.context.session.id), f.context.session);
  } finally { f.cleanup(); }
});

test('missing saved evaluations recover and stale links never resolve to a different artifact', () => {
  const f = fixture();
  try {
    const guide = createScriptedEvaluationPreviewAnswer(f.context).guidance[2]!;
    const missing = { ...f.context, selectedEvaluationId: 'eval-missing' };
    const answer = createScriptedEvaluationPreviewAnswer(missing);
    assert.deepEqual(answer.guidance, []);
    assert.equal(answer.recovery?.state, 'recovery');
    assert.equal(revalidateEvaluationPreviewGuidance(guide, missing).state, 'recovery');
    const changed = f.evaluations.create(f.context.session, { clientOperationId: op(), datasetVersion: 2, name: 'Another saved review', traceIds: f.saved.evaluation.traceIds });
    const selectedOther = { ...f.context, selectedEvaluationId: changed.evaluation.id };
    const resolved = revalidateEvaluationPreviewGuidance(guide, selectedOther);
    assert.equal(resolved.state, 'recovery');
    if (resolved.state === 'recovery') assert.equal(resolved.reason, 'evaluation_changed');
  } finally { f.cleanup(); }
});

test('review edits, dataset changes, owner selection changes and expired demos invalidate old targets', () => {
  const f = fixture();
  try {
    const guide = createScriptedEvaluationPreviewAnswer(f.context).guidance[0]!;
    const detail = f.evaluations.review(f.context.session, f.saved.evaluation.id, { clientOperationId: op(), datasetVersion: 2, expectedVersion: 1,
      responses: [{ traceId: f.saved.evaluation.traceIds[0], questionKey: 'quality', value: 2 }] });
    assert.equal(detail.evaluation.version, 2);
    assert.equal(revalidateEvaluationPreviewGuidance(guide, f.context).state, 'recovery');
    assert.equal(resolveEvaluationPreviewGuidance({ targetId: 'evals.results' }, { ...f.context, session: { ...f.context.session, version: 3 } }).state, 'recovery');
    assert.equal(resolveEvaluationPreviewGuidance({ targetId: 'evals.results' }, { ...f.context, browserSession: { ...f.context.browserSession, activeDemoId: 'other' } }).state, 'recovery');
    assert.equal(revalidateEvaluationPreviewGuidance(guide, { ...f.context, browserSession: { ...f.context.browserSession, version: 99 } }).state, 'recovery');
    f.clock.advance(5 * 60 * 60 * 1000);
    assert.deepEqual(createScriptedEvaluationPreviewAnswer(f.context).guidance, []);
  } finally { f.cleanup(); }
});

test('foreign evaluations and forged trace ownership recover without showing saved contents', () => {
  const f = fixture();
  try {
    const other = f.store.createOwned(null, 'Other browser', undefined, op());
    const foreign = { ...f.context, browserSession: f.store.browserSession(other.ownerId), session: other.session };
    assert.deepEqual(createScriptedEvaluationPreviewAnswer(foreign).guidance, []);
    const poisoned = structuredClone(f.saved);
    poisoned.evaluation.traceSnapshot[0]!.sessionId = other.session.id;
    const invalid = { ...f.context, evaluations: { read: () => poisoned } };
    assert.equal(resolveEvaluationPreviewGuidance({ targetId: 'evals.results' }, invalid).state, 'recovery');
  } finally { f.cleanup(); }
});

test('unscored reviews have criteria but no fabricated results target; input cannot carry selectors or execution', () => {
  const f = fixture();
  try {
    const empty = f.evaluations.create(f.context.session, { clientOperationId: op(), datasetVersion: 2, name: 'Buyer review only', traceIds: f.saved.evaluation.traceIds,
      questions: [{ key: 'useful', label: 'Useful?', type: 'yes_no', reviewer: 'buyer', required: true }] });
    const context = { ...f.context, selectedEvaluationId: empty.evaluation.id };
    const answer = createScriptedEvaluationPreviewAnswer(context);
    assert.deepEqual(answer.guidance.map(guide => guide.targetId), ['evals.evaluator', 'evals.criteria']);
    assert.equal(answer.recovery?.state, 'recovery');
    for (const key of ['selector', 'url', 'action', 'evaluationId', 'recipient']) {
      assert.equal(resolveEvaluationPreviewGuidance({ targetId: 'evals.criteria', [key]: 'untrusted' }, context).state, 'recovery');
    }
    const original = answer.guidance[0]!;
    const restored = revalidateEvaluationPreviewGuidance({ ...original, label: 'Run a paid judge', purpose: 'Send results externally' }, context);
    assert.equal(restored.state, 'resolved');
    if (restored.state === 'resolved') assert.equal(restored.guide.label, original.label);
  } finally { f.cleanup(); }
});
