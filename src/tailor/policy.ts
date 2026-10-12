// A classifier can stop dispatch; it never authorizes a tool, session access, a write or a commercial claim.
// Kept separate from the planner and given only the current text and compact product policy.
import type { ProviderMessage, ProviderUsage } from './contract.ts';

export const POLICY_VERSION = 'tailor-entry-policy-2026-10-12.1' as const;
export const POLICY_OUTCOMES = ['allow_product_question', 'allow_demo_action', 'clarify', 'redirect_off_topic', 'deny_instruction_override'] as const;
export type PolicyOutcome = typeof POLICY_OUTCOMES[number];
export const POLICY_REASONS = ['product_question', 'demo_action', 'ambiguous', 'off_topic', 'instruction_override', 'guard_unavailable', 'invalid_classification'] as const;
export type PolicyReason = typeof POLICY_REASONS[number];
export interface PolicyDecision { outcome: PolicyOutcome; reason: PolicyReason }
export interface PolicyInput {
  /** Trusted code-owned product remit; no retrieved records or model prose. */
  remit: string;
  capabilities: string;
  /** The latest buyer turn, explicitly untrusted. Never the full conversation. */
  latestText: string;
  session: { hasPublishedState: boolean; pendingClarification: { question: string; choices: string[] } | null; resolvedChoice: string | null };
}
export interface PolicyRequest { messages: ProviderMessage[]; responseSchema: 'entry_policy'; maxOutputTokens: number }
export interface PolicyResponse {
  decision: PolicyDecision;
  usage: ProviderUsage | null;
  latencyMs: number;
  requestId?: string;
  stopReason?: string;
  costUsd?: number;
  reservationUsd?: number;
}
export interface PolicyClassifier {
  readonly model: string | null;
  classify(input: PolicyInput, signal?: AbortSignal): Promise<PolicyResponse>;
}
export const POLICY_LIMITS = { maxOutputTokens: 256, timeoutMs: 10_000, maxRetries: 0, maxInputChars: 6_000 } as const;
export const POLICY_DECISION_SCHEMA = {
  type: 'object', properties: {
    outcome: { type: 'string', enum: POLICY_OUTCOMES }, reason: { type: 'string', enum: POLICY_REASONS },
  }, required: ['outcome', 'reason'], additionalProperties: false,
} as const;
const PAIRS: Record<PolicyOutcome, readonly PolicyReason[]> = {
  allow_product_question: ['product_question'], allow_demo_action: ['demo_action'],
  clarify: ['ambiguous', 'guard_unavailable', 'invalid_classification'], redirect_off_topic: ['off_topic'], deny_instruction_override: ['instruction_override'],
};
export function decodePolicyDecision(value: unknown): PolicyDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || typeof v.outcome !== 'string' || typeof v.reason !== 'string') return null;
  if (!(POLICY_OUTCOMES as readonly string[]).includes(v.outcome)) return null;
  const outcome = v.outcome as PolicyOutcome;
  return PAIRS[outcome].includes(v.reason as PolicyReason) ? { outcome, reason: v.reason as PolicyReason } : null;
}

/** Benchmark seam only. These options do not enable an API or cache in the normal runtime. */
export const OPTIONAL_POLICY_BENCHMARK = { enabled: false, classifier: 'none', promptCaching: false } as const;
export interface PolicyBenchmarkCandidate { name: string; classify(input: PolicyInput, signal?: AbortSignal): Promise<PolicyResponse> }
