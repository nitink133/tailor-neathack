// Browser ownership and demo selection are transport/storage concerns, separate from model context.
import type { Clarification } from './contract.ts';

export const DEMO_SWITCH_CHOICES = ['adapt_current', 'start_separate', 'keep_current'] as const;
export type DemoSwitchChoice = typeof DEMO_SWITCH_CHOICES[number];
export interface DemoSummary {
  id: string;
  productId: string;
  label: string;
  version: number;
  conversationVersion: number;
  createdAt: string;
  lastActiveAt: string;
}
export interface DemoSwitchConfirmation extends Clarification {
  kind: 'demo_switch';
  referenceId: string;
  sourceDemoId: string;
  sourceVersion: number;
  browserSessionVersion: number;
  /** Conversation version after the confirmation question is appended. */
  sourceConversationVersion: number;
  requestedSummary: string;
  choices: [
    { id: 'adapt_current'; label: string },
    { id: 'start_separate'; label: string },
    { id: 'keep_current'; label: string },
  ];
}
export interface BrowserSession {
  id: string;
  state: 'active' | 'ended' | 'expired';
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  /** Ownership/selection metadata version, independent from each demo's version. */
  version: number;
  activeDemoId: string | null;
  demos: DemoSummary[];
}
export interface TurnIdentity {
  sessionId: string;
  demoId: string;
  turnId: string;
  clientTurnId: string;
}
/** The HTTP attempt is fresh even when the logical turn replays. */
export interface RequestIdentity extends TurnIdentity { requestId: string }
export interface SelectDemoRequest { demoId: string; expectedVersion: number }
