// Test-only CRM adapter: proves the Tailor core runs a second product with no trace/span or Neatlogs code.
// A Deal has a stage, an amount and an owner; tools are createDeal, moveStage (mutating) and readDeal (read-only).
// Imports only from src/tailor/** (asserted by test/core-crm-adapter.test.ts).

import type { CoreAction, MutationResult, ProductAdapter } from '../../src/tailor/adapter.ts';
import type {
  ChatTurn, Clarification, CoreSession, CoreTurnRequest, KnowledgeIndex, ModelProvider, ProviderRequest, ProviderResponse, TurnTelemetry,
  ValidationIssue,
} from '../../src/tailor/contract.ts';
import { splitSentences } from '../../src/tailor/claims.ts';

export const STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
export interface Deal { id: string; name: string; stage: Stage; amount: number; owner: string }

export interface CrmSession extends CoreSession { deals: Deal[] }
export interface CrmReadback { version: number; deals: Deal[] }
export interface CrmEvidence { version: number; dealIds: string[] }
export interface CrmRecord { id: string; title: string; body: string }

/** What the scripted "model" returns. */
export type CrmAction =
  | { type: 'ask'; clarification: Clarification }
  | { type: 'tool'; tool: string; args: unknown; note: string; cites?: string[] }
  | { type: 'answer'; text: string; sourceIds: string[] }
  | { type: 'refuse'; text: string };

interface CreateArgs { name: string; stage: string; amount: number; owner: string }
interface MoveArgs { dealId: string; stage: string }
interface ReadArgs { dealId: string }

// ---------------------------------------------------------------------------------------------------------------------
// In-memory CRM store with fault switches. Every write is version-checked, then read back independently.
// ---------------------------------------------------------------------------------------------------------------------
export interface CrmFaults { failSave?: boolean; failReadback?: boolean }
export class CrmStore {
  version = 1;
  deals = new Map<string, Deal>();
  writes = 0;
  faults: CrmFaults = {};
  private nextId = 1;
  constructor(seed: Omit<Deal, 'id'>[] = []) { for (const d of seed) { const id = `deal-${this.nextId++}`; this.deals.set(id, { id, ...d }); } }
  snapshot(conversation: ChatTurn[] = []): CrmSession {
    return { id: 'crm-session', version: this.version, conversation, deals: [...this.deals.values()].map(d => ({ ...d })) };
  }
  /** Another writer moves the version under an in-flight turn. */
  bumpElsewhere(): void { this.version++; }
  private commit(expectedVersion: number, apply: () => string): MutationResult<CrmReadback> {
    if (expectedVersion !== this.version) return { state: 'conflict', currentVersion: this.version };
    if (this.faults.failSave) return { state: 'save_failed', version: this.version, reason: 'disk full' };
    const id = apply();
    this.writes++;
    this.version++;
    if (this.faults.failReadback) return { state: 'readback_uncertain', attemptedVersion: this.version, lastKnownVersion: expectedVersion, reason: 'read timed out' };
    const read = this.deals.get(id);
    return read ? { state: 'committed', version: this.version, readback: { version: this.version, deals: [{ ...read }] } } : { state: 'readback_uncertain', attemptedVersion: this.version, lastKnownVersion: expectedVersion, reason: 'missing' };
  }
  ports(): CrmPorts {
    return {
      createDeal: async (args, expectedVersion) => this.commit(expectedVersion, () => {
        const id = `deal-${this.nextId++}`;
        this.deals.set(id, { id, name: args.name, stage: args.stage as Stage, amount: args.amount, owner: args.owner });
        return id;
      }),
      moveStage: async (dealId, stage, expectedVersion) => this.commit(expectedVersion, () => {
        const deal = this.deals.get(dealId)!;
        this.deals.set(dealId, { ...deal, stage });
        return dealId;
      }),
      readDeal: async dealId => { const d = this.deals.get(dealId); return d ? { version: this.version, deal: { ...d } } : null; },
    };
  }
}
export interface CrmPorts {
  createDeal(args: CreateArgs, expectedVersion: number): Promise<MutationResult<CrmReadback>>;
  moveStage(dealId: string, stage: Stage, expectedVersion: number): Promise<MutationResult<CrmReadback>>;
  readDeal(dealId: string): Promise<{ version: number; deal: Deal } | null>;
}

export interface CrmTypes {
  session: CrmSession;
  request: CoreTurnRequest;
  ports: CrmPorts;
  record: CrmRecord;
  action: CrmAction;
  explanation: never;
  readback: CrmReadback;
  detail: Deal;
  evidence: CrmEvidence;
  story: never;
}

// ---------------------------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DEAL_ID = /\bdeal-\d+\b/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function stageIssues(stage: string): ValidationIssue[] {
  return (STAGES as readonly string[]).includes(stage) ? [] : [{ path: 'stage', code: 'UNKNOWN_STAGE', message: `Unknown stage "${stage}"; use one of ${STAGES.join(', ')}` }];
}
const evidenceDeals = (readback: CrmReadback | null, detail: Deal | null): Deal[] => [...(readback?.deals ?? []), ...(detail ? [detail] : [])];

/** Keeps sentences whose deal ids and numbers all appear in the evidence. */
function ground(text: string, readback: CrmReadback | null, detail: Deal | null): string {
  const deals = evidenceDeals(readback, detail);
  const ids = new Set(deals.map(d => d.id));
  const numbers = new Set<number>([...deals.map(d => d.amount), ...(readback ? [readback.version] : [])]);
  return splitSentences(text.trim()).filter(sentence => {
    if ((sentence.match(DEAL_ID) ?? []).some(id => !ids.has(id))) return false;
    const rest = sentence.replace(DEAL_ID, ' ');
    return (rest.match(NUMBER) ?? []).every(n => numbers.has(Number(n.replace(/,/g, ''))));
  }).join(' ');
}
const dealLine = (d: Deal) => `${d.id} “${d.name}” is in stage ${d.stage} at ${d.amount}, owned by ${d.owner}.`;

function describeMutation(readback: CrmReadback, narrative: string, cited: string[]) {
  const deal = readback.deals[0]!;
  return {
    text: `Saved and verified as version ${readback.version}. ${dealLine(deal)}${narrative ? ` ${narrative}` : ''}`,
    evidence: { version: readback.version, dealIds: cited.length ? cited : readback.deals.map(d => d.id) },
  };
}

export const crmAdapter: ProductAdapter<CrmTypes> = {
  id: 'crm-test',
  productNames: ['dealflow'],
  systemPrompt: 'You are Tailor for a test CRM. Reply with one JSON CrmAction.',
  responseSchema: 'crm_action',
  buildContext: ({ session, buyerText, records }) => ({ version: session.version, deals: session.deals, buyerText, knowledge: records.map(r => r.id) }),
  repairMessage: problems => `REPAIR_REQUEST\n${JSON.stringify(problems)}`,
  decodeAction(raw): CoreAction | null {
    if (!isObj(raw)) return null;
    switch (raw.type) {
      case 'ask': return { kind: 'ask', clarification: raw.clarification };
      case 'tool': return { kind: 'tool', tool: raw.tool, args: raw.args, narrative: raw.note, ...(raw.cites ? { cites: raw.cites } : {}) };
      case 'answer': return { kind: 'answer', text: raw.text, sourceIds: raw.sourceIds };
      case 'refuse': return { kind: 'refuse', text: raw.text, reason: 'off_topic' };
      default: return null;
    }
  },
  tools: {
    createDeal: {
      mutates: true,
      parseArgs: (a): CreateArgs | null => (isObj(a) && typeof a.name === 'string' && typeof a.stage === 'string' && typeof a.amount === 'number' && typeof a.owner === 'string'
        ? { name: a.name, stage: a.stage, amount: a.amount, owner: a.owner } : null),
      validate: (a: CreateArgs) => [...stageIssues(a.stage), ...(a.amount < 0 ? [{ path: 'amount', code: 'NEGATIVE_AMOUNT', message: 'Amount must be zero or more' }] : [])],
      execute: (a: CreateArgs, ctx) => ctx.ports.createDeal(a, ctx.session.version),
      echo: (a: CreateArgs, note) => JSON.stringify({ type: 'tool', tool: 'createDeal', args: a, note }),
      describe: (readback, _detail, narrative, cited) => describeMutation(readback, narrative, cited),
    },
    moveStage: {
      mutates: true,
      parseArgs: (a): MoveArgs | null => (isObj(a) && typeof a.dealId === 'string' && typeof a.stage === 'string' ? { dealId: a.dealId, stage: a.stage } : null),
      validate: (a: MoveArgs, ctx) => [
        ...stageIssues(a.stage),
        ...(ctx.session.deals.some(d => d.id === a.dealId) ? [] : [{ path: 'dealId', code: 'UNKNOWN_DEAL', message: `No deal ${a.dealId} in this workspace` }]),
      ],
      execute: (a: MoveArgs, ctx) => ctx.ports.moveStage(a.dealId, a.stage as Stage, ctx.session.version),
      echo: (a: MoveArgs, note) => JSON.stringify({ type: 'tool', tool: 'moveStage', args: a, note }),
      describe: (readback, _detail, narrative, cited) => describeMutation(readback, narrative, cited),
    },
    readDeal: {
      mutates: false,
      parseArgs: (a): ReadArgs | null => (isObj(a) && typeof a.dealId === 'string' ? { dealId: a.dealId } : null),
      async read(a: ReadArgs, ctx) {
        const read = await ctx.ports.readDeal(a.dealId);
        return read ? { state: 'found', detail: read.deal, version: read.version } : { state: 'unavailable', status: 'failed', text: `There is no deal ${a.dealId} to read.` };
      },
      describe: (deal, version, narrative, cited) => ({
        text: `${dealLine(deal)}${narrative ? ` ${narrative}` : ''}`,
        evidence: { version, dealIds: cited.length ? cited : [deal.id] },
      }),
    },
  },
  grounding: {
    ground,
    safeNarrative: (readback, detail) => { const d = evidenceDeals(readback, detail)[0]; return d ? `${d.id} is in stage ${d.stage}.` : ''; },
    citable: (readback, detail) => evidenceDeals(readback, detail).map(d => d.id),
  },
  composeAnswer: cited => cited.map(r => r.body).join(' '),
  recordTitle: r => r.title,
};

// ---------------------------------------------------------------------------------------------------------------------
// Harness pieces (no Neatlogs helpers)
// ---------------------------------------------------------------------------------------------------------------------
/** Returns the scripted actions in order, repeating the last one; records every request it saw. */
export function scriptedCrmProvider(actions: CrmAction[]): ModelProvider<CrmAction, never> & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    name: 'crm-script', model: null, mode: 'mock', effort: null, requests,
    async complete(request): Promise<ProviderResponse<CrmAction>> {
      requests.push(request);
      const action = actions[Math.min(i++, actions.length - 1)]!;
      return { action, usage: null, latencyMs: 0 };
    },
  };
}

export const crmKnowledge: KnowledgeIndex<CrmRecord> = (() => {
  const records: CrmRecord[] = [{ id: 'stages', title: 'Pipeline stages', body: `Deals move through ${STAGES.join(', ')}.` }];
  return { version: 'crm-1', select: () => records, get: id => records.find(r => r.id === id), all: () => records };
})();

export function silentTelemetry(): TurnTelemetry & { events: string[] } {
  const events: string[] = [];
  return {
    turnId: 't', correlationId: 'c', events,
    step: (_name, _attrs, fn) => fn(),
    event: name => { events.push(name); },
    recordUsage: () => {},
  };
}
