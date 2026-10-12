import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEvalOverview, renderEvalWizard, renderEvaluatorEditor } from '../src/clients/neatlogs/eval-ui.ts';

test('renderer escapes caller supplied text and never emits executable evaluator configuration', () => {
  const payload = '</textarea><script>alert(1)</script>';
  const html = renderEvaluatorEditor({step:'instructions',instructions:payload});
  assert.ok(html.includes('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('fetch('));
  assert.match(renderEvalOverview({error:payload}), /&lt;script&gt;/);
});

test('unobserved official steps and local execution boundary stay explicit', () => {
  for (const step of ['schedule','evaluators','form','review'] as const) {
    assert.match(renderEvalWizard({step}), /official screenshot for this step is not yet verified/);
  }
  assert.match(renderEvaluatorEditor({step:'try'}), /No provider request will be made/);
  assert.match(renderEvaluatorEditor({step:'review'}), /does not configure a hosted evaluator/);
});

test('loading and missing evaluation states remain scoped and accessible', () => {
  const loading=renderEvalOverview({loading:true});
  assert.match(loading,/role="status"/);
  assert.match(loading,/Loading evaluations/);
  assert.doesNotMatch(loading,/Loading traces/);
  const error=renderEvalOverview({error:'Please retry.'});
  assert.match(error,/role="alert"/);
  assert.match(error,/data-eval-action="retry"/);
  assert.match(error,/Synthetic · local demo · no AI evaluator ran/);
});

test('all native preview surfaces retain synthetic provenance', () => {
  for (const html of [renderEvalOverview(),renderEvalWizard({step:'type'}),renderEvaluatorEditor({step:'model'})]) {
    assert.match(html,/Synthetic · local demo · no AI evaluator ran/);
  }
});
