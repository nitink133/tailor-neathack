// The one error type live providers throw. The message is operator-safe: it never contains buyer text, prompts,
// model output or credentials. The service maps `kind` to telemetry and a short step detail; buyer copy stays generic.

import type { ProviderErrorKind } from './contract.ts';

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

  constructor(kind: ProviderErrorKind, message: string, extra: { retryable?: boolean; requestId?: string | null; status?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = extra.retryable ?? RETRYABLE[kind];
    if (extra.requestId) this.requestId = extra.requestId;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

export const isProviderError = (error: unknown): error is ProviderError => error instanceof ProviderError;
