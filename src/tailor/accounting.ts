// Browser-safe accounting shapes. Byte counts are exact; token counts are estimates, distinct from provider usage.
export const INPUT_ESTIMATION_VERSION = 'utf8-conservative-v1';
export const PRICING_VERSION = 'tailor-rates-2026-10-12.1';
export type AttemptSettlement = 'not_sent' | 'released' | 'settled_reported' | 'settled_unreconciled' | 'pending';
export interface InputAccounting {
  estimationVersion: string;
  system: { bytes: number; estimatedTokens: number };
  conversation: { bytes: number; estimatedTokens: number };
  schema: { bytes: number; estimatedTokens: number };
  framing: { estimatedTokens: number };
  estimatedInputTokens: number;
  totalInputBytes: number;
}
