// The one error type live providers throw. The message is operator-safe: it never contains buyer text, prompts,
// model output or credentials. The service maps `kind` to telemetry and a short step detail; buyer copy stays generic.

import type { ProviderErrorKind, ProviderUsage } from './contract.ts';
import type { InputAccounting, AttemptSettlement } from './accounting.ts';

/**
 * Whether retrying the same call can plausibly succeed within the same turn. Individual errors may override (e.g. a 500).
 * A timeout is not retried in-turn: a second full-length wait would outlast the turn deadline the buyer is waiting on.
 */
const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  auth: false, permission: false, billing: false, spend_cap: false, rate_limit: true, overloaded: true, timeout: false, network: true,
  invalid_request: false, refusal: false, truncated: false, malformed: true, context_exceeded: false, unknown: false,
};

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  retryable: boolean;
  requestId?: string;
  status?: number;
  /** Stop reason when the provider answered but the answer was unusable (refusal, max_tokens, ...). */
  stopReason?: string;
  /** Known cost of the failed call (0 when certainly not billed); absent means unknown. */
  costUsd?: number;
  /** Worst-case USD reserved for the failed call; kept against the cap when `costUsd` is unknown. */
  reservationUsd?: number;
  usage: ProviderUsage | null = null;
  latencyMs?: number;
  reservationRef?: string;
  settlement?: AttemptSettlement;
  pricingVersion?: string;
  inputAccounting?: InputAccounting;

  constructor(kind: ProviderErrorKind, message: string, extra: { retryable?: boolean; requestId?: string | null; status?: number; stopReason?: string | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = extra.retryable ?? RETRYABLE[kind];
    if (extra.requestId) this.requestId = extra.requestId;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.stopReason) this.stopReason = extra.stopReason;
  }
}

export const isProviderError = (error: unknown): error is ProviderError => error instanceof ProviderError;
