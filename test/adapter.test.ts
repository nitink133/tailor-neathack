import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_LABEL, adapt } from '../src/adapter.ts';

test('prototype adapter chooses a fixture, asks once, or explains without claiming a model', () => {
  const ask = adapt({ text: 'a fictional shop', hasSession: false, activeScenario: null });
  assert.equal(ask.action, 'ask');
  assert.equal(ask.scenario, null);
  assert.match(ask.text, new RegExp(ADAPTER_LABEL));
  assert.match(ask.text, /both attempts fail/);

  const created = adapt({ text: 'First attempt fails, retry recovers', hasSession: false, activeScenario: null });
  assert.equal(created.action, 'create');
  assert.equal(created.scenario, 'recovered');

  const both = adapt({ text: 'retry recovers and both attempts fail', hasSession: false, activeScenario: null });
  assert.equal(both.action, 'ask');

  const same = adapt({ text: 'show the retry that recovers', hasSession: true, activeScenario: 'recovered' });
  assert.equal(same.action, 'unchanged');

  const next = adapt({ text: 'both attempts fail, safely escalate', hasSession: true, activeScenario: 'recovered' });
  assert.equal(next.action, 'switch');
  assert.equal(next.scenario, 'exhausted');
  assert.match(next.text, /previous fixture stays/);

  const explained = adapt({ text: 'explain this trace', hasSession: true, activeScenario: 'exhausted' });
  assert.equal(explained.action, 'explain');
  assert.match(explained.text, /No model/);
});
