// The Tailor core with a second, test-only product (a CRM): the real `handleTurn` drives a scripted provider through
// the adapter's tools, and every outcome is classified by the core from what the tools returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTailorCore, type CoreTurnInput } from '../src/tailor/core.ts';
import { systemClock } from '../src/tailor/contract.ts';
import type { MutatingTool } from '../src/tailor/adapter.ts';
import { CrmStore, crmAdapter, crmKnowledge, scriptedCrmProvider, silentTelemetry, type CrmAction, type CrmTypes } from './helpers/crm-adapter.ts';

const core = createTailorCore(crmAdapter);
const seed = () => new CrmStore([{ name: 'Acme renewal', stage: 'qualified', amount: 12000, owner: 'Priya' }]);
let turn = 0;

function input(store: CrmStore, actions: CrmAction[], text = 'Move the Acme renewal to won'): CoreTurnInput<CrmTypes> & { provider: ReturnType<typeof scriptedCrmProvider>; telemetry: ReturnType<typeof silentTelemetry> } {
  return {
    session: store.snapshot(),
    request: { text, clientTurnId: `crm-turn-${++turn}` },
    tools: store.ports(),
    knowledge: crmKnowledge,
    telemetry: silentTelemetry(),
    clock: systemClock,
    provider: scriptedCrmProvider(actions),
  };
}
const move = (stage: string, note = 'Moved deal-1 to the next stage.', cites?: string[]): CrmAction =>
  ({ type: 'tool', tool: 'moveStage', args: { dealId: 'deal-1', stage }, note, ...(cites ? { cites } : {}) });

test('the CRM helper adapter imports nothing from the Neatlogs adapter or infrastructure', () => {
  const source = readFileSync(new URL('./helpers/crm-adapter.ts', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]!);
  assert.ok(specifiers.length > 0, 'the import scan found the helper imports');
  for (const s of specifiers) {
    assert.doesNotMatch(s, /clients\/neatlogs|src\/clients\//, `crm-adapter must not import ${s}`);
    assert.doesNotMatch(s, /src\/infrastructure\//, `crm-adapter must not import ${s}`);
    assert.match(s, /^(?:\.\.\/\.\.\/src\/tailor\/|node:)/, `crm-adapter imports only the core: ${s}`);
  }
});

test('a valid edit commits and the reply is grounded in the readback', async () => {
  const store = seed();
  const turnInput = input(store, [move('won', 'Moved deal-1 to won at 12000.')]);
  const result = await core.handleTurn(turnInput);
  assert.equal(result.outcome, 'committed');
  assert.equal(store.deals.get('deal-1')!.stage, 'won');
  assert.equal(store.version, 2);
  assert.deepEqual(result.evidence, { version: 2, deals: [{ id: 'deal-1', name: 'Acme renewal', stage: 'won', amount: 12000, owner: 'Priya' }] });
  const reply = result.messages[0]!;
  assert.equal(reply.status, 'applied');
  assert.match(reply.text, /^Saved and verified as version 2\. deal-1 “Acme renewal” is in stage won at 12000, owned by Priya\./);
  assert.match(reply.text, /Moved deal-1 to won at 12000\./, 'grounded narrative survives');
  assert.deepEqual(reply.evidence, { version: 2, dealIds: ['deal-1'] });
  assert.deepEqual(result.steps.filter(s => ['validate', 'save', 'readback'].includes(s.name)).map(s => `${s.name}:${s.status}`), ['validate:ok', 'save:ok', 'readback:ok']);
});

test('an unknown stage is rejected with the adapter’s validation message and nothing changes', async () => {
  const store = seed();
  const turnInput = input(store, [move('negotiating')]);
  const result = await core.handleTurn(turnInput);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.messages[0]!.text, /Unknown stage "negotiating"; use one of lead, qualified, proposal, won, lost \(UNKNOWN_STAGE\)/);
  assert.match(result.messages[0]!.text, /version 1 is still live/);
  assert.equal(store.writes, 0, 'validation runs in code before any write');
  assert.equal(store.version, 1);
  assert.equal(store.deals.get('deal-1')!.stage, 'qualified');
  // The model was asked to repair (bounded), with the adapter's problems attached.
  assert.equal(turnInput.provider.requests.length, 3);
  assert.equal(turnInput.provider.requests[1]!.repairOf?.[0]?.code, 'UNKNOWN_STAGE');
});

test('a repaired action after a rejection commits', async () => {
  const store = seed();
  const result = await core.handleTurn(input(store, [move('negotiating'), move('proposal', 'Moved deal-1 to proposal.')]));
  assert.equal(result.outcome, 'committed');
  assert.equal(store.deals.get('deal-1')!.stage, 'proposal');
});

test('a stale version gives conflict and nothing is written', async () => {
  const store = seed();
  const turnInput = input(store, [move('won')]);
  store.bumpElsewhere();
  const result = await core.handleTurn(turnInput);
  assert.equal(result.outcome, 'conflict');
  assert.match(result.messages[0]!.text, /live version is now 2/);
  assert.equal(store.writes, 0);
  assert.equal(store.deals.get('deal-1')!.stage, 'qualified');
});

test('a save failure gives save_failed and the last version stays live', async () => {
  const store = seed();
  store.faults.failSave = true;
  const result = await core.handleTurn(input(store, [move('won')]));
  assert.equal(result.outcome, 'save_failed');
  assert.match(result.messages[0]!.text, /couldn’t save that \(disk full\)\. Nothing changed: version 1 is still live/);
  assert.equal(store.deals.get('deal-1')!.stage, 'qualified');
});

test('a readback failure gives readback_uncertain, never success or "unchanged"', async () => {
  const store = seed();
  store.faults.failReadback = true;
  const result = await core.handleTurn(input(store, [move('won')]));
  assert.equal(result.outcome, 'readback_uncertain');
  assert.equal(result.messages[0]!.status, 'uncertain');
  assert.match(result.messages[0]!.text, /couldn’t confirm the result/);
  assert.doesNotMatch(result.messages[0]!.text, /Saved and verified|Nothing changed/);
  assert.equal(result.evidence, undefined);
});

test('an invented citation (a deal id not in the readback) is stripped from the reply', async () => {
  const store = new CrmStore([
    { name: 'Acme renewal', stage: 'qualified', amount: 12000, owner: 'Priya' },
    { name: 'Globex pilot', stage: 'lead', amount: 4000, owner: 'Sam' },
  ]);
  const result = await core.handleTurn(input(store, [move('won', 'Moved deal-1 to won. deal-999 closed for 50000 as well.', ['deal-1', 'deal-999', 'deal-2'])]));
  assert.equal(result.outcome, 'committed');
  const reply = result.messages[0]!;
  assert.doesNotMatch(reply.text, /deal-999|50000/);
  assert.match(reply.text, /Moved deal-1 to won\./);
  assert.deepEqual(reply.evidence, { version: 2, dealIds: ['deal-1'] }, 'only ids the readback contains can be cited');
});

test('an unpermitted tool the model asks for is refused in code and never executes', async () => {
  const store = seed();
  const ports = store.ports();
  let portCalls = 0;
  const counted = new Proxy(ports, { get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === 'function' ? (...a: unknown[]) => { portCalls++; return (v as (...x: unknown[]) => unknown)(...a); } : v; } });
  const turnInput = { ...input(store, [{ type: 'tool', tool: 'deleteAllDeals', args: {}, note: 'Deleted everything.' }], 'Delete every deal'), tools: counted };
  const result = await core.handleTurn(turnInput);
  assert.equal(result.outcome, 'refused');
  assert.match(result.messages[0]!.text, /isn’t an action I’m allowed to take.*Nothing was changed\./);
  assert.equal(portCalls, 0);
  assert.equal(store.writes, 0);
  assert.equal(store.deals.size, 1);
  assert.ok(turnInput.telemetry.events.includes('tool_refused'));
});

test('inherited object keys are not tools either', async () => {
  const store = seed();
  for (const tool of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const result = await core.handleTurn(input(store, [{ type: 'tool', tool, args: {}, note: '' }]));
    assert.equal(result.outcome, 'refused', tool);
  }
  assert.equal(store.writes, 0);
});

test('a read tool answers from what it read and cannot write', async () => {
  const store = seed();
  const result = await core.handleTurn(input(store, [{ type: 'tool', tool: 'readDeal', args: { dealId: 'deal-1' }, note: 'deal-1 is worth 12000. deal-7 is worth 99.' }], 'What is deal-1 worth?'));
  assert.equal(result.outcome, 'answered');
  assert.match(result.messages[0]!.text, /^deal-1 “Acme renewal” is in stage qualified at 12000, owned by Priya\. deal-1 is worth 12000\.$/);
  assert.deepEqual(result.messages[0]!.evidence, { version: 1, dealIds: ['deal-1'] });
  assert.equal(store.writes, 0);
});

test('createDeal commits through the same core path', async () => {
  const store = seed();
  const result = await core.handleTurn(input(store, [{ type: 'tool', tool: 'createDeal', args: { name: 'Initech expansion', stage: 'lead', amount: 8000, owner: 'Ana' }, note: 'Created deal-2 for 8000.' }], 'Add Initech'));
  assert.equal(result.outcome, 'committed');
  assert.equal(store.deals.get('deal-2')!.name, 'Initech expansion');
  assert.match(result.messages[0]!.text, /Created deal-2 for 8000\./);
});

test('the core’s tool-call budget bounds the adapter’s ports', async () => {
  const moveStage = crmAdapter.tools.moveStage as MutatingTool<CrmTypes>;
  const greedy = createTailorCore<CrmTypes>({
    ...crmAdapter,
    tools: { ...crmAdapter.tools, moveStage: { ...moveStage, execute: async (args, ctx) => { for (let i = 0; i < 10; i++) await ctx.ports.readDeal('deal-1'); return moveStage.execute(args, ctx); } } },
  });
  const store = seed();
  const result = await greedy.handleTurn(input(store, [move('won')]));
  assert.equal(result.outcome, 'rejected');
  assert.match(result.messages[0]!.text, /ran out of steps/);
  assert.equal(store.writes, 0);
});
