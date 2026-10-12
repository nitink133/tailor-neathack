import type { DemoSession, Trace } from './contracts.ts';

export const ROUTING_SCHEMA_VERSION = '2026-10-12.1' as const;
export const ROUTING_RECIPIENTS = ['Engineering on-call', 'Quality reviewer', 'Product owner'] as const;
export const ROUTING_DESTINATIONS = ['slack', 'email', 'in_app'] as const;
/** Threshold counts only outcomeKind=failure; recovered errors and escalation outcomes do not count. */
export type RoutingRule = { type: 'per_event' } | { type: 'threshold'; failedTraceThreshold: number };
export interface RoutingMatch { traceId: string; spanIds: string[]; owner: typeof ROUTING_RECIPIENTS[number]; context: string }
export interface RoutingPreview {
  id: string; schemaVersion: typeof ROUTING_SCHEMA_VERSION; version: number; datasetVersion: number;
  name: string; rule: RoutingRule; traceIds: string[]; traceSnapshot: Trace[];
  recipient: typeof ROUTING_RECIPIENTS[number]; destination: typeof ROUTING_DESTINATIONS[number];
  severity: 'warning' | 'critical'; cooldownMs: number;
  mode: 'synthetic'; provenance: 'local_trace_snapshot';
  matches: RoutingMatch[]; conditionMet: boolean; observedFailedTraceCount: number;
  delivery: 'simulated' | 'not_triggered'; createdAt: string;
  /** This is a stored configuration preview; no timers, dispatch, or destination connection exists. */
  deliveryNote: string;
}
export interface RoutingDetail { preview: RoutingPreview; stale: boolean }
export interface RoutingList { datasetVersion: number; previews: RoutingDetail[] }
export interface CreateRoutingRequest {
  clientOperationId: string; datasetVersion: number; name: string; traceIds: string[]; rule: RoutingRule;
  recipient: RoutingPreview['recipient']; destination: RoutingPreview['destination'];
  severity: RoutingPreview['severity']; cooldownMs: number;
}
export interface StoredRoutingPreview { preview: RoutingPreview; operation: { id: string; fingerprint: string } }
export interface RoutingRepository {
  list(demoId: string): StoredRoutingPreview[];
  read(demoId: string, id: string): StoredRoutingPreview | null;
  compareAndSet(demoId: string, id: string, version: number | null, next: StoredRoutingPreview): boolean;
}
export interface RoutingService {
  list(session: DemoSession): RoutingList;
  read(session: DemoSession, id: string): RoutingDetail;
  create(session: DemoSession, body: unknown): RoutingDetail;
}
