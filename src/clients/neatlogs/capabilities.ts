// Trusted, vetted public product map. No buyer text, credentials, private IDs, prices or inferred entitlements.
import type { CapabilityRecord, KnowledgeSource } from './agent-contract.ts';
import { loadKnowledge } from './knowledge.ts';

export const CAPABILITY_MAP_VERSION = '2026-10-12.1' as const;
export const VERIFIED_ON = '2026-10-12' as const;
export type CloneSupport = 'executable' | 'explain_only' | 'not_implemented' | 'refused';
export interface CapabilityMapRecord extends CapabilityRecord {
  productLimitations: string[];
  cloneSupport: { state: CloneSupport; tools: string[]; uiSurfaces: string[]; evidence: string[] };
  hostedAvailability: { state: 'unknown' | 'documented_gated'; operationGate?: string; sources: KnowledgeSource[] };
}
export interface CapabilityStarter { id: string; capabilityId: string; title: string; prompt: string }
export interface PublicCapabilities {
  version: string;
  verifiedOn: string;
  starters: CapabilityStarter[];
  capabilities: { id: string; title: string; scope: CapabilityRecord['scope']; support: CloneSupport; surfaces: string[]; limitations: string[]; hostedAvailability: CapabilityMapRecord['hostedAvailability']['state'] }[];
}
export const CAPABILITY_STARTERS: readonly CapabilityStarter[] = [
  { id:'retrieval-quality', capabilityId:'synthetic-quality-workflows', title:'Check a grounded answer', prompt:'I’m building a documentation question-answering agent. Show a relevant retrieval whose answer claims a feature absent from the source.' },
  { id:'extraction-quality', capabilityId:'synthetic-quality-workflows', title:'Find missing extracted fields', prompt:'Create a fictional invoice extraction workflow that omits the due date from otherwise valid JSON.' },
  { id:'support-quality', capabilityId:'synthetic-quality-workflows', title:'Review whether support helped', prompt:'I’m building a customer support agent. Show a successful lookup followed by a polite answer that doesn’t resolve the request.' },
];
export function publicCapabilities(): PublicCapabilities {
  const index = loadKnowledge();
  const records = index.all() as readonly CapabilityMapRecord[];
  return { version:index.version, verifiedOn:VERIFIED_ON, starters:structuredClone([...CAPABILITY_STARTERS]), capabilities:records.map(r => ({
    id:r.id,title:r.title,scope:r.scope,support:r.cloneSupport.state,surfaces:[...r.cloneSupport.uiSurfaces],
    limitations:[...r.productLimitations,...r.limitations],hostedAvailability:r.hostedAvailability.state,
  })) };
}
/** Compact product remit for entry classification BEFORE retrieval; external input is never interpolated here. */
export function capabilityRemitSummary(): string {
  return `Tailor demonstrates Neatlogs on isolated fictional data. It can create/edit saved trace workflows, inspect span I/O, errors and timing, filter traces, show graph/timeline, and explain documented capabilities. Quality examples include retrieval grounding, structured extraction completeness and support resolution as well as retries/guardrails. The local Evals page creates forms, assigns buyer or simulated review per question, saves buyer answers and derives results. Simulated scores are deterministic demo values; no hosted AI evaluator runs. Official evals, alerts, replay, analytics, SDKs and integrations can be discussed. Hosted API access, pricing and plan entitlements are unverified. The demo cannot mutate accounts/projects, connect integrations, ingest real data, run arbitrary code or access other visitors. Follow-ups, relevant coding/research/industry questions and product limits belong within this remit. Map ${CAPABILITY_MAP_VERSION}.`;
}
