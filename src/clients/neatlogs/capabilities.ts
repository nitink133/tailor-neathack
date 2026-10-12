// Trusted, vetted public product map. No buyer text, credentials, private IDs, prices or inferred entitlements.
import type { CapabilityRecord, KnowledgeSource } from './agent-contract.ts';
import { loadKnowledge } from './knowledge.ts';

export const CAPABILITY_MAP_VERSION = '2026-10-12.2' as const;
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
    limitations:[...new Set([...r.productLimitations,...r.limitations])],hostedAvailability:r.hostedAvailability.state,
  })) };
}
/** Compact product remit for entry classification BEFORE retrieval; external input is never interpolated here. */
export function capabilityRemitSummary(): string {
  return `Tailor demonstrates Neatlogs on isolated fictional data. Create/edit trace workflows; inspect span input/output, errors and timing; filter traces; show graph/timeline. Quality examples include retrieval grounding, extraction completeness and support resolution. Evals saves forms, per-question buyer or simulated reviewers, answers and aggregates. Simulated scores are illustrative. Fixed no-error, latency and output-field checks execute on saved snapshots; no hosted AI judge runs. Alerts previews error events or failure-outcome thresholds with fictional roles/destinations; no messages are sent. Personal notifications and evaluation updates are distinct; Update me needs clarification. Official evals, alerts, replay, analytics and integrations can be explained. Hosted access and buyer entitlements are unverified. No accounts, real data, integration connections, arbitrary code or other visitors. Relevant industry/coding/research/product follow-ups belong here. Map ${CAPABILITY_MAP_VERSION}.`;
}
