export type Scenario = 'recovered' | 'exhausted';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Span {
  id: string; parentId: string | null; name: string;
  kind: 'WORKFLOW' | 'GUARDRAIL' | 'TOOL' | 'RETRIEVAL' | 'CHAIN';
  startMs: number; durationMs: number; status: 'OK' | 'ERROR';
  input: Json; output: Json; error: string | null; detection: boolean;
}
export interface Trace {
  id: string; sessionId: string; scenario: Scenario; name: string;
  ingestedAt: string; status: 'Ready'; outcome: 'order_found' | 'escalation_required';
  tags: string[]; input: Json; output: Json; spans: Span[];
}
export interface Dataset { activeScenario: Scenario; traces: Trace[] }
export interface ChatTurn {
  id: string;
  role: 'buyer' | 'adapter';
  text: string;
  status: 'pending' | 'applied' | 'failed' | 'note';
  at: string;
}
export interface DemoSession {
  id: string; description: string; createdAt: string; version: number; dataset: Dataset;
  conversation: ChatTurn[];
}
export interface CreateSession { description: string; scenario: Scenario }
export interface Proposal { expectedVersion: number; dataset: Dataset }
export interface TraceQuery { q?: string; scenario?: Scenario; detection?: 'yes' | 'no'; tag?: string; minMs?: number; maxMs?: number }
export interface TraceList { version: number; activeScenario: Scenario; total: number; filtered: number; traces: Trace[] }
export interface ApiError { error: { code: string; message: string } }
