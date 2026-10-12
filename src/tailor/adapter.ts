import type { PolicyDecision, PolicyResponse } from './policy.ts';
// The ProductAdapter contract: everything product-specific the Tailor core needs, injected at construction.
// The core owns sequencing, permissions, budgets, the deadline, idempotency and outcome classification; an adapter
// supplies schemas, context, tools, validation, readback and grounding. Types only (no runtime imports).

import type {
  ChatStatus, Clarification, Clock, CoreSession, CoreTurnRequest, ModelProvider, ProviderMessage, TurnStep, ValidationIssue,
} from './contract.ts';

/** Type map for one product. Each slot is the product's own shape; the core never inspects them. */
export interface AdapterTypes {
  /** Per-turn session snapshot (extends the core's id/version/conversation). */
  session: CoreSession;
  /** Per-turn request (extends the core's text/clientTurnId/choiceId). */
  request: CoreTurnRequest;
  /** Session-bound data access the tools use. The core budgets every call; none of them takes a session id. */
  ports: object;
  /** Knowledge record cited by answers. */
  record: unknown;
  /** The model's action as the provider decoded it from the adapter's response schema. */
  action: unknown;
  /** The explanation call's output, as the provider decoded it. */
  explanation: unknown;
  /** Authoritative readback carried by a committed mutation. */
  readback: unknown;
  /** Detail read after a commit or by a read tool, used to ground narration (e.g. the saved record in full). */
  detail: unknown;
  /** Citation shape attached to replies (wire evidence). */
  evidence: unknown;
  /** Product memo persisted with a commit. */
  story: unknown;
}

/** What the adapter's decoder turns a model action into. The core acts only on these. */
export type CoreAction =
  | { kind: 'ask'; clarification: Clarification }
  /** A tool request. `tool` is whatever the model named; the core refuses anything the adapter did not list. */
  | { kind: 'tool'; tool: string; args: unknown; narrative: string; cites?: string[] }
  | { kind: 'answer'; text: string; sourceIds: string[] }
  | { kind: 'unsupported'; text: string; sourceId?: string }
  | { kind: 'refuse'; text: string; reason: string };

export type MutationResult<TReadback> =
  | { state: 'committed'; version: number; readback: TReadback }
  | { state: 'rejected'; problems: ValidationIssue[]; version: number }
  | { state: 'conflict'; currentVersion: number }
  | { state: 'save_failed'; version: number; reason: string }
  /** Transaction may have committed; the independent read failed. Caller must NOT claim unchanged or success. */
  | { state: 'readback_uncertain'; attemptedVersion: number; lastKnownVersion: number; reason: string }
  | { state: 'expired' }
  | { state: 'unsupported'; reason: string };

export interface ToolContext<T extends AdapterTypes> {
  session: T['session'];
  request: T['request'];
  /** The resolved buyer text for this turn (a chosen clarification label, or the typed text). */
  buyerText: string;
  /** Budgeted ports: each call counts against maxToolCallsPerTurn and throws once the budget is spent. */
  ports: T['ports'];
  clock: Clock;
  /** Records a turn step (and its telemetry span) around `fn`. */
  step<V>(name: TurnStep['name'], attributes: Record<string, string | number | boolean>, fn: () => Promise<V>, detail?: (value: V) => string | undefined): Promise<V>;
}

export type RefusalReason = 'injection' | 'arbitrary_code' | 'cross_session' | 'real_mutation' | 'off_topic';
/** A deterministic adapter decision. It cannot grant additional tool permissions. */
export type PreflightDecision =
  | { kind: 'continue' }
  | { kind: 'ask'; clarification: Clarification; reason?: 'needs_context' | 'material_switch' }
  | { kind: 'refuse'; text: string; reason: RefusalReason };

export type AdapterPreflightResult = PreflightDecision & { policy?: PolicyDecision; accounting?: PolicyResponse };

export interface Reply<TEvidence> { text: string; evidence?: TEvidence }

/** A tool that changes product state. The core runs `validate` (when given) before `execute`; a rejected action never executes. */
export interface MutatingTool<T extends AdapterTypes, TArgs = unknown> {
  readonly mutates: true;
  /** Optional code-owned confirmation gate, before validation or execution. Calls use budgeted ports. */
  beforeMutation?(args: TArgs, ctx: ToolContext<T>): Promise<PreflightDecision> | PreflightDecision;
  /** Structural argument check. null = malformed model output (retried inside the repair budget). */
  parseArgs(args: unknown): TArgs | null;
  /**
   * Domain validation against the turn's session snapshot, in code, before anything executes. Problems go back to the
   * model as a repair request. Optional only when `execute` itself validates and returns `rejected` without writing.
   */
  validate?(args: TArgs, ctx: ToolContext<T>): ValidationIssue[];
  /** Validate again against current state, save transactionally, read back independently. Never partially applies. */
  execute(args: TArgs, ctx: ToolContext<T>): Promise<MutationResult<T['readback']>>;
  /** The attempted action as the model would have written it, for the repair conversation. */
  echo(args: TArgs, narrative: string): string;
  /** Optional detail read after a commit (budgeted ports). null when unavailable; narration then uses the readback. */
  readDetail?(readback: T['readback'], ctx: ToolContext<T>): Promise<T['detail'] | null>;
  /** Optional evidence-grounded explanation call after a commit (providers with `explain`). */
  explanation?: {
    responseSchema: string;
    messages(input: { buyerText: string; args: TArgs; readback: T['readback']; detail: T['detail'] | null }): ProviderMessage[];
    decode(raw: T['explanation']): { text: string; cites: string[] } | null;
    /** Skip the call when narration has nothing to ground against. */
    needsDetail?: boolean;
  };
  /** Reply built from the readback (+ detail). `narrative` is already grounded; `cited` holds only citable ids. */
  describe(readback: T['readback'], detail: T['detail'] | null, narrative: string, cited: string[]): Reply<T['evidence']>;
  /** Product memo to persist with the commit, already bounded. */
  storyOf?(args: TArgs): T['story'];
}

/** A tool that only reads. It can never change state, and its reply is grounded against what it read. */
export interface ReadTool<T extends AdapterTypes, TArgs = unknown> {
  readonly mutates: false;
  parseArgs(args: unknown): TArgs | null;
  /** Read through budgeted ports. `unavailable` carries the truthful reply when nothing could be read. */
  read(args: TArgs, ctx: ToolContext<T>): Promise<{ state: 'found'; detail: T['detail']; version: number } | { state: 'unavailable'; text: string; status: ChatStatus }>;
  describe(detail: T['detail'], version: number, narrative: string, cited: string[]): Reply<T['evidence']>;
}

export type ToolDefinition<T extends AdapterTypes> = MutatingTool<T, any> | ReadTool<T, any>;

/** Buyer-facing copy the core needs that names product things. Anything omitted falls back to neutral wording. */
export interface AdapterCopy {
  /** load_context step detail when no clarification choice was used. */
  contextLoaded: string;
  /** Provider spend cap reached before planning. */
  budgetExhausted: string;
  rejected(version: number, problems: string): string;
  conflict(currentVersion: number): string;
  /** Detail on the failed save step after a conflict. */
  conflictStep: string;
  unsupportedChange(reason: string): string;
  uncertain(lastKnownVersion: number): string;
  /** An answer cited no known record. */
  noVerifiedRecord: string;
  /** A read tool threw. */
  readFailed: string;
  /** The model asked for a tool the adapter does not permit. */
  toolNotPermitted: string;
  /** Detail on the explanation step after a commit. */
  explainStep: string;
}

/** Grounding: which ids may be cited, and how model prose is checked against what was read back. */
export interface Grounding<T extends AdapterTypes> {
  /** Sentences of raw model `text` (the adapter cleans it) that the readback/detail can back; '' when none. Never invents. */
  ground(text: string, readback: T['readback'] | null, detail: T['detail'] | null): string;
  /** Deterministic wording from the evidence, used when the model wrote prose and none of it survived grounding. */
  safeNarrative(readback: T['readback'] | null, detail: T['detail'] | null): string;
  /** Ids the reply may cite. Model citations outside this set are dropped by the core. */
  citable(readback: T['readback'] | null, detail: T['detail'] | null): Iterable<string>;
}

export interface ProductAdapter<T extends AdapterTypes = AdapterTypes> {
  readonly id: string;
  /** Bounded relevance/safety check before retrieval, context construction or model calls. */
  preflight?(input: { session: T['session']; request: T['request']; buyerText: string; choice: { id: string; label: string } | null; provider: ModelProvider<T['action'], T['explanation']>; signal?: AbortSignal }): AdapterPreflightResult | Promise<AdapterPreflightResult>;
  /** Product names model prose must not make capability/plan claims about (fed to the core's claim filters). */
  readonly productNames: readonly string[];
  /** Planning call: system prompt and the response-schema name the provider satisfies. */
  readonly systemPrompt: string;
  readonly responseSchema: string;
  /** Bounded, structured product context for the planning call (summaries, never other sessions). */
  buildContext(input: { session: T['session']; request: T['request']; history: T['session']['conversation']; buyerText: string; choice: { id: string; label: string } | null; question: Clarification | null; records: T['record'][]; knowledgeVersion: string }): unknown;
  /** The repair request sent after a validation rejection. */
  repairMessage(problems: ValidationIssue[]): string;
  /** Structural decode of the provider's action into a core action. null = malformed. */
  decodeAction(raw: T['action']): CoreAction | null;
  /** The permitted tool set. A tool the model names that is not a key here never executes. */
  readonly tools: Readonly<Record<string, ToolDefinition<T>>>;
  readonly grounding: Grounding<T>;
  /** Knowledge answers are composed by code from the cited records; provider prose adds at most a filtered lead. */
  composeAnswer(cited: T['record'][], buyerText: string, providerText: string, knowledgeVersion?: string): string;
  recordTitle(record: T['record']): string;
  /**
   * Saved, code-owned domain text (story labels, names, tags) that model prose without read-back evidence may cite:
   * clarification questions/labels, refusals and unsupported replies. Numbers and plan-like words in that prose are
   * kept only when they appear here or in the buyer's own words. Absent: only the buyer's words ground them.
   */
  groundingText?(session: T['session']): string;
  /** Final buyer-facing wording pass over every reply text (e.g. internal terms → buyer terms). */
  buyerWording?(text: string): string;
  /** Stable id of a knowledge record, for telemetry (retrieved source ids). Absent: only the record count is reported. */
  recordId?(record: T['record']): string;
  /** Version of the prompt text (system prompt, framing notes) this adapter sends; reported with every turn. */
  readonly promptVersion?: string;
  /** Optional: turn an uncited answer into a (permission-checked) tool action, e.g. "explain this record". */
  redirectUncitedAnswer?(action: Extract<CoreAction, { kind: 'answer' }>, ctx: { request: T['request']; buyerText: string }): Extract<CoreAction, { kind: 'tool' }> | null;
  readonly copy?: Partial<AdapterCopy>;
}
