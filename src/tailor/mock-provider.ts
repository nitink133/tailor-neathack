// Offline provider shell: the product-agnostic part of the deterministic mock. An adapter supplies the heuristic
// `decide` and the strict `check` its live provider is held to; the shell reports no usage and labels itself as mock.

import type { ModelProvider, ProviderRequest, ProviderResponse } from './contract.ts';

export interface OfflineProviderOptions<TAction> {
  /** Heuristic stand-in for a model: reads the framed request and returns one action. */
  decide(request: ProviderRequest): unknown;
  /** Round-trip through the same strict parser a live provider uses; null = the shell throws. */
  check(action: unknown): TAction | null;
}

export function createOfflineProvider<TAction>(options: OfflineProviderOptions<TAction>): ModelProvider<TAction, never> {
  return {
    name: 'tailor-mock',
    model: null,
    mode: 'mock',
    effort: null,
    async complete(request: ProviderRequest): Promise<ProviderResponse<TAction>> {
      const started = performance.now();
      const checked = options.check(options.decide(request));
      if (!checked) throw new Error('Mock provider produced an invalid action');
      return { action: checked, usage: null, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    },
  };
}
