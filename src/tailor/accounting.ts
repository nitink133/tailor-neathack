// Browser-safe accounting shapes. Byte counts are exact; token counts are estimates, distinct from provider usage.
export const INPUT_ESTIMATION_VERSION = 'utf8-conservative-v1';
export const PRICING_VERSION = 'tailor-rates-2026-10-12.2';
export type AttemptSettlement = 'not_sent' | 'released' | 'settled_reported' | 'settled_unreconciled' | 'pending';
/** Allowlisted provider counters in their original field names. Missing is unavailable, never zero.
 * This is diagnostic evidence only; spend settlement still uses the independently validated ProviderUsage. */
export interface ReportedProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens: number };
}
export interface ProviderMetadata {
  requestedModel: string;
  /** Validated API response model id; never substitute the requested alias when absent. */
  resolvedModel?: string;
  reportedUsage?: ReportedProviderUsage;
  /** Anthropic output_tokens includes thinking_tokens; do not add them again. */
  outputTokensIncludeThinking: true;
}
/** Closed provider id syntax for API response metadata, not a priced/available-model declaration. */
export const isResolvedAnthropicModel = (value: unknown): value is string => typeof value === 'string' && value.length <= 100
  && /^claude-(?:(?:haiku|sonnet|opus)-[0-9]+(?:[.-][0-9]+)*|[0-9]+(?:-[0-9]+)*-(?:haiku|sonnet|opus)(?:-[0-9]{8})?)(?:-latest)?$/.test(value);

/** Scalar projection for the telemetry allowlist; never serialise the metadata object wholesale. */
export function providerMetadataAttrs(metadata?: ProviderMetadata): Record<string, string | number | boolean> {
  if (!metadata) return {};
  const u = metadata.reportedUsage;
  return {
    requestedModel: metadata.requestedModel,
    ...(metadata.resolvedModel ? { resolvedModel: metadata.resolvedModel } : {}),
    outputTokensIncludeThinking: metadata.outputTokensIncludeThinking,
    reportedUsageAvailable: u !== undefined,
    ...(u ? { reportedInputTokens: u.input_tokens, reportedOutputTokens: u.output_tokens,
      ...(u.cache_read_input_tokens !== undefined ? { reportedCacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens !== undefined ? { reportedCacheWriteTokens: u.cache_creation_input_tokens } : {}),
      ...(u.cache_creation?.ephemeral_5m_input_tokens !== undefined ? { reportedCacheWrite5mTokens: u.cache_creation.ephemeral_5m_input_tokens } : {}),
      ...(u.cache_creation?.ephemeral_1h_input_tokens !== undefined ? { reportedCacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens } : {}),
      ...(u.output_tokens_details ? { reportedThinkingTokens: u.output_tokens_details.thinking_tokens } : {}),
    } : {}),
  };
}
export interface InputAccounting {
  estimationVersion: string;
  system: { bytes: number; estimatedTokens: number };
  conversation: { bytes: number; estimatedTokens: number };
  schema: { bytes: number; estimatedTokens: number };
  framing: { estimatedTokens: number };
  estimatedInputTokens: number;
  totalInputBytes: number;
  /** Mapped API conversation messages; system is counted separately. */
  messageCount?: number;
  /** SHA-256 of the mapped system text and JSON schema only. No buyer/history hashes.
   * These identify reusable components, not an API tokenizer count or an enabled cache boundary. */
  systemPrefixSha256?: string;
  schemaSha256?: string;
}
