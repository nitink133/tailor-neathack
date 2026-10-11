// The Tailor core: ONE server-side product agent, made product-specific only by the injected ProductAdapter.
// The model (provider) interprets requests, asks clarifications, requests bounded tool actions and narrates. CODE
// enforces budgets, permissions, grounding, copy truthfulness and loop termination.
//
//   load_context -> retrieve_knowledge -> model (<=3 calls, <=2 repairs, <=1 escalation)
//   -> act on exactly one core action through the adapter's permitted tools (<=6 port calls) -> grounded reply
//
// Success is only ever claimed from an independent read-back carried by the tool result.

import {
  CORE_LIMITS as LIMITS,
  type ChatStatus, type Clarification, type ExecutionLabel, type KnowledgeIndex, type ModelProvider, type ProviderMessage,
  type TailorMessage, type TurnOutcome, type TurnResult, type TurnStep, type TurnTelemetry, type Clock, type ValidationIssue,
} from './contract.ts';
import type { AdapterCopy, AdapterTypes, CoreAction, MutatingTool, MutationResult, ProductAdapter, ReadTool, ToolContext } from './adapter.ts';
import { createClaimRules, splitSentences } from './claims.ts';
import { resolveTurnText } from './conversation.ts';
import { userMessage } from './prompts.ts';
import { clip, cleanNarrative, oneLine } from './text.ts';
import { isProviderError, ProviderError } from './provider-error.ts';
import { PER_CALL_OUTPUT_TOKEN_CEILING } from './spend.ts';

/**
 * Turn-loop limits that extend CORE_LIMITS.
 * - turnDeadlineMs: wall-clock bound for ALL provider calls in one turn (planning, repairs, escalation, explanation).
 *   The turn ends `provider_unavailable` before a browser would give up; it is longer than one provider call
 *   (LIMITS.providerTimeoutMs) so a fast retry still fits, and a timed-out call is never retried in-turn.
 * - providerGraceMs: the core's per-call backstop is providerTimeoutMs + this, strictly longer than the
 *   provider-owned timeout, so the provider normally times out (and settles its spend reservation) first.
 * - minCallBudgetMs: no new provider call starts with less than this left before the deadline.
 * - planningMaxOutputTokens: upper bound the core requests; the provider clamps it to its effort-aware ceiling.
 */
export const AGENT_LIMITS = {
  turnDeadlineMs: 90_000,
  providerGraceMs: 5_000,
  minCallBudgetMs: 5_000,
  planningMaxOutputTokens: PER_CALL_OUTPUT_TOKEN_CEILING,
} as const;

/** Thrown by budgeted ports once the per-turn tool-call budget is spent. */
export class BudgetError extends Error {}

const REFUSE_FALLBACK = 'I can’t help with that request.';
const UNSUPPORTED_FALLBACK = 'That’s outside what this demo can do.';

const NEUTRAL_COPY: AdapterCopy = {
  contextLoaded: 'Read the conversation and saved state',
  budgetExhausted: 'This demo’s model budget is used up, so I can’t plan new changes right now and I haven’t changed anything.',
  rejected: (version, problems) => `I couldn’t make a valid change from that, so nothing was saved and version ${version} is still live. What the checks flagged: ${problems || 'the change did not pass validation'}. Try rephrasing, or ask for something simpler.`,
  conflict: current => `The saved state changed while I was working (the live version is now ${current}), so nothing was saved and your last good version is still live. Ask again and I’ll start from the latest.`,
  conflictStep: 'The saved state changed meanwhile',
  unsupportedChange: reason => `That isn’t something this demo can do: ${reason}. I didn’t change anything.`,
  uncertain: lastKnown => `I sent that change, but I couldn’t confirm the result, so I can’t tell you whether it went through. The last version I could confirm was ${lastKnown}; please check before asking for another change.`,
  noVerifiedRecord: 'I don’t have a verified record that answers that, so I won’t guess.',
  readFailed: 'I couldn’t read that just now, so I won’t describe it from memory. Please try again.',
  toolNotPermitted: 'That isn’t an action I’m allowed to take in this demo.',
  explainStep: 'Wrote the explanation from the saved evidence',
};

export interface CoreTurnInput<T extends AdapterTypes> {
  session: T['session'];
  request: T['request'];
  /** Session-bound ports for the adapter's tools (no session-id parameter anywhere). */
  tools: T['ports'];
  knowledge: KnowledgeIndex<T['record']>;
  telemetry: TurnTelemetry;
  clock: Clock;
  provider: ModelProvider<T['action'], T['explanation']>;
  /** Optional stronger provider for one bounded escalation; absent until approved. */
  escalationProvider?: ModelProvider<T['action'], T['explanation']>;
}
export type CoreTurnResult<T extends AdapterTypes> = TurnResult<T['evidence'], T['readback'], T['story']>;

export interface TailorCore<T extends AdapterTypes> {
  handleTurn(input: CoreTurnInput<T>): Promise<CoreTurnResult<T>>;
}

/** Wraps every function on the ports object so each call is charged against the tool-call budget. */
function budgetPorts<P extends object>(ports: P, spend: () => void): P {
  return new Proxy(ports, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { spend(); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
}

/** Backstop for providers that ignore their signal. Aborting the signal is what makes a live provider stop and settle. */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProviderError('timeout', 'The provider call did not finish in time', { retryable: false })); }, Math.max(0, ms));
  });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function problemSummary(problems: ValidationIssue[]): string {
  return problems.slice(0, 3).map(p => oneLine(`${p.message || p.code} (${p.code})`, 140)).join('; ');
}

// ---------------------------------------------------------------------------------------------------------------------
// Telemetry helpers. Only ids, counts, versions and short tokens leave the core: never buyer text, prompts, model
// output, tool argument values or private reasoning. The telemetry layer re-validates every key and value.
// ---------------------------------------------------------------------------------------------------------------------
type Attrs = Record<string, string | number | boolean>;
type Purpose = 'plan' | 'repair' | 'escalate' | 'explain';
const PURPOSE: Record<'model' | 'repair' | 'escalate' | 'explain', Purpose> = { model: 'plan', repair: 'repair', escalate: 'escalate', explain: 'explain' };
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ARG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ISSUE_CODE = /^[A-Z0-9_]{1,40}$/;
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const DECISION_MAX = 240;

/** Model-authored tool names are reported only when they look like identifiers. */
const toolToken = (name: string) => (TOOL_NAME.test(name) ? name : 'invalid_name');
/** Argument shape only: sorted top-level key names and the serialised size. Values never leave the core. */
function argSummary(args: unknown): Attrs {
  let bytes = 0;
  try { bytes = JSON.stringify(args)?.length ?? 0; } catch { bytes = 0; }
  const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).filter(k => ARG_KEY.test(k)).sort().slice(0, 16) : [];
  return { argKeyCount: keys.length, argBytes: bytes, ...(keys.length ? { argKeys: keys.join(',') } : {}) };
}
function issueAttrs(problems: readonly ValidationIssue[]): Attrs {
  const codes = [...new Set(problems.map(p => p.code).filter(c => ISSUE_CODE.test(c)))].slice(0, 10);
  return { issueCount: problems.length, ...(codes.length ? { issueCodes: codes.join(',') } : {}) };
}
/** Version the store reports after a mutation attempt (the last confirmed one when the outcome is unknown). */
function versionAfter(result: MutationResult<unknown>): number | null {
  switch (result.state) {
    case 'committed': case 'rejected': case 'save_failed': return result.version;
    case 'conflict': return result.currentVersion;
    case 'readback_uncertain': return result.lastKnownVersion;
    default: return null;
  }
}
const sentenceCount = (text: string | undefined) => (cleanNarrative(text) ? splitSentences(cleanNarrative(text)).length : 0);

export function createTailorCore<T extends AdapterTypes>(adapter: ProductAdapter<T>): TailorCore<T> {
  const copy: AdapterCopy = { ...NEUTRAL_COPY, ...adapter.copy };
  const claims = createClaimRules(adapter.productNames);
  const permitted = new Map(Object.entries(adapter.tools));

  function normaliseClarification(c: Clarification): Clarification | null {
    // Clarification text is model-authored and reaches the buyer verbatim: strip invented prices/plans/capabilities first.
    const question = clip(claims.sanitiseClarificationText(c.question), 300);
    const labels = c.choices.map(x => clip(claims.sanitiseClarificationText(x.label.trim()), 80));
    if (!question || labels.some(l => !l)) return null;
    if (new Set(labels.map(l => l.toLowerCase())).size !== 3) return null;
    return { question, choices: [{ id: 'c1', label: labels[0]! }, { id: 'c2', label: labels[1]! }, { id: 'c3', label: labels[2]! }], allowFreeText: true };
  }

  /** Per-turn count of model sentences and citations removed by grounding (telemetry only). */
  interface Drops { n: number }
  /** Grounded model prose, or deterministic evidence wording when the model wrote prose and none of it survived. */
  function groundOrFallback(text: string | undefined, readback: T['readback'] | null, detail: T['detail'] | null, drops: Drops): string {
    const grounded = adapter.grounding.ground(text ?? '', readback, detail);
    drops.n += Math.max(0, sentenceCount(text) - sentenceCount(grounded));
    if (grounded) return grounded;
    return cleanNarrative(text) ? adapter.grounding.safeNarrative(readback, detail) : '';
  }
  /** Model citations survive only when the adapter says the evidence contains them. */
  function citedOnly(ids: readonly string[] | undefined, readback: T['readback'] | null, detail: T['detail'] | null, drops: Drops): string[] {
    if (!ids?.length) return [];
    const known = new Set(adapter.grounding.citable(readback, detail));
    const kept = [...new Set(ids.filter(id => known.has(id)))];
    drops.n += new Set(ids).size - kept.length;
    return kept;
  }

  async function handleTurn(input: CoreTurnInput<T>): Promise<CoreTurnResult<T>> {
    const { session, request, knowledge, telemetry, clock, provider } = input;
    type Message = TailorMessage<T['evidence']>;
    type Result = CoreTurnResult<T>;
    const steps: TurnStep[] = [];
    // `effort` is only present for providers that expose one (live); the mock label stays {mode, provider, model}.
    const execution: ExecutionLabel = { mode: provider.mode, provider: provider.name, model: provider.model, ...(provider.effort ? { effort: provider.effort } : {}) };
    let providerCalls = 0;
    let repairs = 0;
    let escalations = 0;
    let toolCalls = 0;
    const turnStartedAt = clock.now();
    const deadlineAt = turnStartedAt + AGENT_LIMITS.turnDeadlineMs;
    /** Time the next provider call may take: the per-call backstop, cut to what is left of the turn deadline. */
    const callBudgetMs = () => Math.min(LIMITS.providerTimeoutMs + AGENT_LIMITS.providerGraceMs, deadlineAt - clock.now());
    /** Last failure from a live provider; decides retry behaviour and the buyer-facing unavailable copy. */
    let lastProviderError: ProviderError | null = null;
    const ports = budgetPorts(input.tools, () => {
      if (toolCalls >= LIMITS.maxToolCallsPerTurn) throw new BudgetError('Tool call budget exhausted');
      toolCalls++;
    });
    /** Telemetry-only decision trail ("plan→publish v3→readback ok→committed"): tokens chosen by code, never model prose. */
    const decision: string[] = [];
    const decide = (token: string) => { decision.push(token); };
    const drops: Drops = { n: 0 };
    const annotate = (attributes: Attrs) => { try { telemetry.annotate?.(attributes); } catch { /* telemetry never changes a turn */ } };
    annotate({ adapterId: adapter.id, knowledgeVersion: knowledge.version, ...(adapter.promptVersion ? { promptVersion: adapter.promptVersion } : {}) });

    const finish = (outcome: TurnOutcome, message: Message, extra: Partial<Result> = {}): Result =>
      ({ outcome, messages: [message], steps, execution, ...extra });
    const note = (text: string, status: ChatStatus = 'note', more: Partial<Message> = {}): Message => ({ role: 'tailor', text, status, ...more });

    async function step<V>(name: TurnStep['name'], attributes: Record<string, string | number | boolean>, fn: () => Promise<V>, detail?: (value: V) => string | undefined): Promise<V> {
      const started = clock.now();
      try {
        const value = await telemetry.step(name, attributes, fn);
        const d = detail?.(value);
        steps.push({ name, status: 'ok', ...(d ? { detail: d } : {}), durationMs: Math.max(0, clock.now() - started) });
        return value;
      } catch (error) {
        // Operator-safe detail only: the provider error KIND ('auth', 'rate_limit', 'spend_cap', …), never a message or payload.
        steps.push({ name, status: 'failed', ...(isProviderError(error) ? { detail: error.kind } : {}), durationMs: Math.max(0, clock.now() - started) });
        throw error;
      }
    }

    /** Attributes opening one provider attempt (attempt number, purpose, model and effort; prompt caching is not enabled). */
    function attemptAttrs(prov: ModelProvider<T['action'], T['explanation']>, purpose: Purpose): Attrs {
      return {
        provider: prov.name, mode: prov.mode, attempt: providerCalls, purpose, promptCaching: false,
        ...(prov.model ? { model: prov.model } : {}), ...(prov.effort ? { effort: prov.effort } : {}),
      };
    }
    /** Outcome of one provider attempt, recorded on that attempt's telemetry step. The mock is free: its cost is known (0). */
    function attemptSettled(prov: ModelProvider<T['action'], T['explanation']>, r: { usage: unknown; latencyMs: number; requestId?: string; stopReason?: string; costUsd?: number; reservationUsd?: number }, result: 'ok' | 'invalid'): void {
      const cost = r.costUsd ?? (prov.mode === 'mock' ? 0 : undefined);
      annotate({
        attemptResult: result, latencyMs: r.latencyMs, costKnown: cost !== undefined,
        ...(cost !== undefined ? { costUsd: cost } : {}), ...(r.reservationUsd !== undefined ? { reservationUsd: r.reservationUsd } : {}),
        ...(r.requestId ? { requestId: r.requestId } : {}), ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      });
    }
    function attemptFailed(prov: ModelProvider<T['action'], T['explanation']>, error: unknown): void {
      if (!isProviderError(error)) { annotate({ attemptResult: 'error', providerErrorKind: 'unknown', costKnown: prov.mode === 'mock', ...(prov.mode === 'mock' ? { costUsd: 0 } : {}) }); return; }
      const cost = error.costUsd ?? (prov.mode === 'mock' ? 0 : undefined);
      annotate({
        attemptResult: 'error', providerErrorKind: error.kind, retryable: error.retryable, timeout: error.kind === 'timeout', costKnown: cost !== undefined,
        ...(cost !== undefined ? { costUsd: cost } : {}), ...(error.reservationUsd !== undefined ? { reservationUsd: error.reservationUsd } : {}),
        ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.stopReason ? { stopReason: error.stopReason } : {}),
      });
    }

    const result = await (async (): Promise<Result> => {
    try {
      // 1. load_context ------------------------------------------------------------------------------------------------
      const resolved = await step('load_context', { turnCount: session.conversation.length, version: session.version }, async () => resolveTurnText(session, request),
        r => (r.choice ? 'Used your choice' : copy.contextLoaded));
      const ctx: ToolContext<T> = { session, request, buyerText: resolved.effectiveText, ports, clock, step };
      // 2. retrieve_knowledge ------------------------------------------------------------------------------------------
      const records = await step('retrieve_knowledge', {
        maxRecords: LIMITS.maxKnowledgeRecordsPerTurn, adapterId: adapter.id, knowledgeVersion: knowledge.version,
        ...(adapter.promptVersion ? { promptVersion: adapter.promptVersion } : {}),
      }, async () => {
        const selected = knowledge.select(resolved.effectiveText, LIMITS.maxKnowledgeRecordsPerTurn).slice(0, LIMITS.maxKnowledgeRecordsPerTurn);
        const ids = adapter.recordId ? selected.map(r => adapter.recordId!(r)).filter(id => RECORD_ID.test(id)) : [];
        annotate({ recordCount: selected.length, ...(ids.length ? { sourceIds: ids.join(',') } : {}) });
        return selected;
      }, r => `${r.length} knowledge ${r.length === 1 ? 'record' : 'records'}`);
      const context = adapter.buildContext({
        session, request, history: resolved.history, buyerText: resolved.effectiveText, choice: resolved.choice, question: resolved.question,
        records, knowledgeVersion: knowledge.version,
      });
      const messages: ProviderMessage[] = [
        { role: 'system', content: adapter.systemPrompt },
        { role: 'user', content: userMessage(context, resolved.effectiveText) },
      ];

      // 3. model --------------------------------------------------------------------------------------------------------
      /** Decodes and normalises a raw provider action; null when it is unusable (counts as an invalid attempt). */
      function interpret(raw: T['action']): CoreAction | null {
        const action = adapter.decodeAction(raw);
        if (!action) return null;
        if (action.kind === 'ask') {
          const c = normaliseClarification(action.clarification);
          return c ? { kind: 'ask', clarification: c } : null;
        }
        if (action.kind === 'tool') {
          // Unlisted tools pass through so they are refused (never executed); listed tools must parse.
          const tool = permitted.get(action.tool);
          if (tool && tool.parseArgs(action.args) === null) return null;
        }
        return action;
      }
      async function callOnce(prov: ModelProvider<T['action'], T['explanation']>, name: 'model' | 'repair' | 'escalate', repairOf?: ValidationIssue[]): Promise<CoreAction | null> {
        const purpose = PURPOSE[name];
        const budgetMs = callBudgetMs();
        if (budgetMs < AGENT_LIMITS.minCallBudgetMs) {
          lastProviderError = new ProviderError('timeout', 'The turn deadline leaves no time for another provider call', { retryable: false });
          telemetry.event('provider_error', { provider: prov.name, kind: 'timeout', retryable: false });
          decide(`${purpose}:no_time`);
          return null;
        }
        providerCalls++;
        try {
          const { response, action } = await step(name, attemptAttrs(prov, purpose), () =>
            withTimeout(signal => prov.complete({ messages, responseSchema: adapter.responseSchema, maxOutputTokens: AGENT_LIMITS.planningMaxOutputTokens, ...(repairOf ? { repairOf } : {}) }, signal), budgetMs)
              .then(r => {
                const decoded = interpret(r.action);
                telemetry.recordUsage(r.usage, prov.model);
                attemptSettled(prov, r, decoded ? 'ok' : 'invalid');
                return { response: r, action: decoded };
              }, error => { attemptFailed(prov, error); throw error; }),
          name === 'repair' ? () => 'Fixed what the checks flagged' : name === 'escalate' ? () => 'Asked a stronger model once' : () => 'Planned the response');
          telemetry.event('provider_latency', { provider: prov.name, latencyMs: response.latencyMs });
          if (response.requestId) telemetry.event('provider_request_id', { provider: prov.name, requestId: response.requestId });
          decide(action ? purpose : `${purpose}:invalid`);
          return action;
        } catch (error) {
          if (isProviderError(error)) {
            lastProviderError = error;
            telemetry.event('provider_error', { provider: prov.name, kind: error.kind, retryable: error.retryable, ...(error.requestId ? { requestId: error.requestId } : {}) });
            decide(`${purpose}:${error.kind}`);
          } else {
            telemetry.event('provider_error', { provider: prov.name, kind: error instanceof Error ? error.name : 'unknown' });
            decide(`${purpose}:error`);
          }
          return null;
        }
      }
      /** One logical model step: invalid output or a thrown error is retried inside the repair/call budgets. */
      async function acquire(prov: ModelProvider<T['action'], T['explanation']>, name: 'model' | 'repair' | 'escalate', repairOf?: ValidationIssue[]): Promise<CoreAction | null> {
        let first = true;
        for (;;) {
          if (providerCalls >= LIMITS.maxProviderCallsPerTurn) return null;
          if (!first) { if (repairs >= LIMITS.maxRepairsPerTurn) return null; repairs++; }
          first = false;
          lastProviderError = null;
          const action = await callOnce(prov, name, repairOf);
          if (action) return action;
          // Auth, billing, spend-cap, refusal… will not improve on a retry; do not burn the repair budget on them.
          if (lastProviderError && !(lastProviderError as ProviderError).retryable) return null;
        }
      }

      const action = await acquire(provider, 'model');
      if (!action) {
        if ((lastProviderError as ProviderError | null)?.kind === 'spend_cap') return finish('provider_unavailable', note(copy.budgetExhausted, 'failed'));
        return finish('provider_unavailable', note('I couldn’t get a usable answer from my planning step just now, so I haven’t changed anything. Please try again in a moment.', 'failed'));
      }

      // 4. act ----------------------------------------------------------------------------------------------------------
      switch (action.kind) {
        case 'ask': decide('ask'); return finish('clarification', note(action.clarification.question, 'question', { clarification: action.clarification }), { clarification: action.clarification });
        case 'tool': return await runTool(action);
        case 'answer': return await actOnAnswer(action);
        case 'unsupported': decide('unsupported'); return actOnUnsupported(action);
        case 'refuse':
          decide(`refuse:${/^[a-z_]{1,24}$/.test(action.reason) ? action.reason : 'other'}`);
          return finish('refused', note(`${oneLine(claims.stripUngroundedClaims(cleanNarrative(action.text)) || REFUSE_FALLBACK, 400)} Nothing was changed.`));
      }

      // ---------------------------------------------------------------------------------------------------------------
      /** Permission enforcement: only a tool the adapter listed can run, and only through its own kind of path. */
      async function runTool(a: Extract<CoreAction, { kind: 'tool' }>): Promise<Result> {
        const tool = permitted.get(a.tool);
        const name = toolToken(a.tool);
        if (!tool) {
          await telemetry.step('tool', { toolName: name, permitted: false, resultState: 'refused', ...argSummary(a.args) }, async () => null);
          telemetry.event('tool_refused', { reason: 'not_permitted', toolName: name });
          decide(`${name}:not_permitted`);
          return finish('refused', note(`${copy.toolNotPermitted} Nothing was changed.`));
        }
        const args = tool.parseArgs(a.args);
        if (args === null) { decide(`${name}:bad_args`); return finish('provider_unavailable', note('I couldn’t get a usable answer from my planning step just now, so I haven’t changed anything. Please try again in a moment.', 'failed')); }
        return tool.mutates ? await actOnMutation(a.tool, tool, args, a.narrative, a.cites) : await actOnRead(name, tool, args, a.narrative, a.cites);
      }

      async function actOnMutation(name: string, tool: MutatingTool<T>, firstArgs: unknown, firstNarrative: string, firstCites: string[] | undefined): Promise<Result> {
        let args = firstArgs;
        let narrative = firstNarrative;
        let cites = firstCites;
        let problems: ValidationIssue[] = [];
        let lastVersion = session.version;
        let executions = 0;
        const label = toolToken(name);
        for (;;) {
          const started = clock.now();
          let result: MutationResult<T['readback']>;
          // Domain validation runs in code before anything executes: a rejected action never reaches `execute`.
          const verdict = tool.validate
            ? await telemetry.step('validate', { toolName: label }, async () => { const v = tool.validate!(args, ctx); annotate({ state: v.length ? 'rejected' : 'ok', ...issueAttrs(v) }); return v; })
            : [];
          if (verdict.length) result = { state: 'rejected', problems: verdict, version: lastVersion };
          else {
            executions++;
            const before = lastVersion;
            try {
              result = await telemetry.step('tool', { toolName: label, permitted: true, mutates: true, attempt: executions, versionBefore: before, ...argSummary(args) }, async () => {
                const r = await tool.execute(args, ctx);
                const after = versionAfter(r);
                annotate({ resultState: r.state, ...(after !== null ? { versionAfter: after } : {}), ...(r.state === 'readback_uncertain' ? { attemptedVersion: r.attemptedVersion } : {}) });
                return r;
              });
            }
            catch (error) {
              if (error instanceof BudgetError) {
                decide(`${label}:budget`);
                return finish('rejected', note(`I ran out of steps for this message before I could save anything. Version ${lastVersion} is still live.`, 'failed'));
              }
              telemetry.event('publish_threw', { kind: error instanceof Error ? error.name : 'unknown' });
              await telemetry.step('readback', { state: 'uncertain', lastKnownVersion: session.version }, async () => null);
              decide(`${label}:threw`); decide('readback uncertain');
              steps.push({ name: 'save', status: 'failed', detail: 'No confirmation received' }, { name: 'readback', status: 'failed' });
              return finish('readback_uncertain', note(copy.uncertain(session.version), 'uncertain'));
            }
          }
          const durationMs = Math.max(0, clock.now() - started);
          recordMutationSteps(result, durationMs);
          if (result.state === 'rejected') telemetry.event('validation', { toolName: label, state: 'rejected', source: verdict.length ? 'code' : 'tool', ...issueAttrs(result.problems) });
          else if (result.state === 'committed' || result.state === 'save_failed' || result.state === 'readback_uncertain') telemetry.event('validation', { toolName: label, state: 'ok', source: tool.validate ? 'code' : 'tool', issueCount: 0 });
          decide(result.state === 'committed' ? `${label} v${result.version}` : `${label} ${result.state}`);

          if (result.state === 'rejected') {
            problems = result.problems; lastVersion = result.version;
            // Budgets: repairs are bounded; escalation (one strong-model attempt) replaces the last repair after a failed repair.
            if (repairs >= LIMITS.maxRepairsPerTurn || providerCalls >= LIMITS.maxProviderCallsPerTurn) return rejected(problems, lastVersion);
            repairs++;
            const escalate = input.escalationProvider && escalations < LIMITS.maxEscalationsPerTurn && repairs > 1;
            if (escalate) escalations++;
            messages.push({ role: 'assistant', content: tool.echo(args, narrative) }, { role: 'user', content: adapter.repairMessage(problems) });
            const next = await acquire(escalate ? input.escalationProvider! : provider, escalate ? 'escalate' : 'repair', problems);
            if (!next || next.kind !== 'tool' || next.tool !== name) { if (next) decide('repair:other_action'); return rejected(problems, lastVersion); }
            const nextArgs = tool.parseArgs(next.args);
            if (nextArgs === null) return rejected(problems, lastVersion);
            args = nextArgs; narrative = next.narrative; cites = next.cites;
            continue;
          }
          return await conclude(label, tool, result, args, narrative, cites);
        }
      }

      function recordMutationSteps(result: MutationResult<T['readback']>, durationMs: number): void {
        switch (result.state) {
          case 'committed':
            steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'ok', durationMs }, { name: 'readback', status: 'ok' }); break;
          case 'rejected':
            steps.push({ name: 'validate', status: 'failed', detail: problemSummary(result.problems), durationMs }, { name: 'save', status: 'skipped' }, { name: 'readback', status: 'skipped' }); break;
          case 'conflict':
            steps.push({ name: 'save', status: 'failed', detail: copy.conflictStep, durationMs }, { name: 'readback', status: 'skipped' }); break;
          case 'save_failed':
            steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'failed', durationMs }, { name: 'readback', status: 'skipped' }); break;
          case 'readback_uncertain':
            steps.push({ name: 'validate', status: 'ok' }, { name: 'save', status: 'failed', detail: 'No confirmation received', durationMs }, { name: 'readback', status: 'failed' }); break;
          case 'expired':
          case 'unsupported':
            steps.push({ name: 'save', status: 'skipped', durationMs }); break;
        }
      }

      function rejected(why: ValidationIssue[], version: number): Result {
        return finish('rejected', note(copy.rejected(version, problemSummary(why)), 'failed'));
      }

      async function conclude(label: string, tool: MutatingTool<T>, result: Exclude<MutationResult<T['readback']>, { state: 'rejected' }>, args: unknown, planned: string, plannedCites: string[] | undefined): Promise<Result> {
        switch (result.state) {
          case 'committed': {
            const readback = result.readback;
            telemetry.event('commit', { toolName: label, version: result.version, versionBefore: session.version });
            // The authoritative readback came back with the commit; the optional detail read and the evidence ids are recorded here.
            const detail = await telemetry.step('readback', { toolName: label, version: result.version }, async () => {
              let read: T['detail'] | null = null;
              let detailState = tool.readDetail ? 'ok' : 'not_requested';
              if (tool.readDetail) {
                try { read = await tool.readDetail(readback, ctx); if (read === null) detailState = 'missing'; }
                catch { read = null; detailState = 'failed'; }
              }
              const ids = [...adapter.grounding.citable(readback, read)];
              annotate({ state: 'ok', detailState, evidenceCount: ids.length, ...(ids.length ? { evidenceRefs: ids.slice(0, 8).join(',') } : {}) });
              return read;
            });
            decide('readback ok');
            let narrative = groundOrFallback(planned, readback, detail, drops);
            let cited = citedOnly(plannedCites, readback, detail, drops);
            if (tool.explanation && (detail !== null || !tool.explanation.needsDetail)) {
              const live = await explainFromEvidence(tool, args, readback, detail);
              if (live) { narrative = live.narrative; cited = live.cited.length ? live.cited : cited; }
            }
            const reply = tool.describe(readback, detail, narrative, cited);
            const story = tool.storyOf?.(args);
            return finish('committed', note(reply.text, 'applied', reply.evidence !== undefined ? { evidence: reply.evidence } : {}), { evidence: readback, ...(story !== undefined ? { story } : {}) });
          }
          case 'conflict':
            return finish('conflict', note(copy.conflict(result.currentVersion), 'failed'));
          case 'save_failed':
            return finish('save_failed', note(`I couldn’t save that${result.reason ? ` (${oneLine(result.reason, 120)})` : ''}. Nothing changed: version ${result.version} is still live.`, 'failed'));
          case 'readback_uncertain':
            await telemetry.step('readback', { toolName: label, state: 'uncertain', attemptedVersion: result.attemptedVersion, lastKnownVersion: result.lastKnownVersion }, async () => null);
            decide('readback uncertain');
            return finish('readback_uncertain', note(copy.uncertain(result.lastKnownVersion), 'uncertain'));
          case 'expired':
            return finish('expired', note('This demo has ended or expired, so I can no longer read or change anything. Start a new demo to continue.'));
          case 'unsupported':
            return finish('unsupported', note(copy.unsupportedChange(oneLine(result.reason, 200))));
        }
      }

      /**
       * Optional second provider call (live providers): narrate ONLY the read-back evidence. One call, inside the shared
       * provider budget. Any failure keeps the turn committed and falls back to the (grounded) planning narrative.
       */
      async function explainFromEvidence(tool: MutatingTool<T>, args: unknown, readback: T['readback'], detail: T['detail'] | null): Promise<{ narrative: string; cited: string[] } | null> {
        const spec = tool.explanation!;
        if (!provider.explain) return null;
        if (providerCalls >= LIMITS.maxProviderCallsPerTurn) { telemetry.event('explain_unavailable', { kind: 'budget' }); decide('explain:budget'); return null; }
        const budgetMs = callBudgetMs();
        if (budgetMs < AGENT_LIMITS.minCallBudgetMs) { telemetry.event('explain_unavailable', { kind: 'timeout' }); decide('explain:no_time'); return null; }
        providerCalls++;
        try {
          const messages = spec.messages({ buyerText: resolved.effectiveText, args, readback, detail });
          const response = await step('explain', attemptAttrs(provider, 'explain'), () =>
            withTimeout(signal => provider.explain!({ messages, responseSchema: spec.responseSchema, maxOutputTokens: LIMITS.maxExplanationOutputTokens }, signal), budgetMs)
              .then(r => {
                telemetry.recordUsage(r.usage, provider.model);
                attemptSettled(provider, r, spec.decode(r.explanation) ? 'ok' : 'invalid');
                return r;
              }, error => { attemptFailed(provider, error); throw error; }),
          () => copy.explainStep);
          telemetry.event('provider_latency', { provider: provider.name, latencyMs: response.latencyMs });
          if (response.requestId) telemetry.event('provider_request_id', { provider: provider.name, requestId: response.requestId });
          const explanation = spec.decode(response.explanation);
          if (!explanation) { telemetry.event('explain_unavailable', { kind: 'malformed' }); decide('explain:invalid'); return null; }
          const narrative = adapter.grounding.ground(explanation.text, readback, detail);
          drops.n += Math.max(0, sentenceCount(explanation.text) - sentenceCount(narrative));
          if (!narrative) { telemetry.event('explain_unavailable', { kind: 'ungrounded' }); decide('explain:ungrounded'); return null; }
          decide('explain');
          return { narrative, cited: citedOnly(explanation.cites, readback, detail, drops) };
        } catch (error) {
          const kind = isProviderError(error) ? error.kind : error instanceof Error ? error.name : 'unknown';
          telemetry.event('explain_unavailable', { kind });
          decide(`explain:${isProviderError(error) ? error.kind : 'error'}`);
          return null;
        }
      }

      async function actOnRead(label: string, tool: ReadTool<T>, args: unknown, planned: string, plannedCites: string[] | undefined): Promise<Result> {
        let read: Awaited<ReturnType<ReadTool<T>['read']>>;
        try {
          read = await telemetry.step('tool', { toolName: label, permitted: true, mutates: false, attempt: 1, ...argSummary(args) }, async () => {
            const r = await tool.read(args, ctx);
            annotate({ resultState: r.state, ...(r.state === 'found' ? { version: r.version } : {}) });
            return r;
          });
        }
        catch { decide(`${label} failed`); return finish('answered', note(copy.readFailed, 'failed')); }
        if (read.state === 'unavailable') { decide(`${label} unavailable`); return finish('answered', note(read.text, read.status)); }
        decide(`${label} found v${read.version}`);
        const narrative = groundOrFallback(planned, null, read.detail, drops);
        const reply = tool.describe(read.detail, read.version, narrative, citedOnly(plannedCites, null, read.detail, drops));
        return finish('answered', note(reply.text, 'note', reply.evidence !== undefined ? { evidence: reply.evidence } : {}));
      }

      async function actOnAnswer(a: Extract<CoreAction, { kind: 'answer' }>): Promise<Result> {
        const cited = [...new Set(a.sourceIds)].map(id => knowledge.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined).slice(0, LIMITS.maxKnowledgeRecordsPerTurn);
        drops.n += new Set(a.sourceIds).size - cited.length;
        if (!cited.length) {
          const redirect = adapter.redirectUncitedAnswer?.(a, { request, buyerText: resolved.effectiveText });
          if (redirect) { decide('answer:redirect'); return await runTool(redirect); }
          decide('answer:no_record');
          return finish('answered', note(copy.noVerifiedRecord));
        }
        decide(`answer:${cited.length}_sources`);
        // The reply is composed by code from the cited records; provider prose can add at most one filtered lead sentence.
        return finish('answered', note(adapter.composeAnswer(cited, resolved.effectiveText, a.text)));
      }

      function actOnUnsupported(a: Extract<CoreAction, { kind: 'unsupported' }>): Result {
        const record = a.sourceId ? knowledge.get(a.sourceId) : undefined;
        const title = record !== undefined ? adapter.recordTitle(record) : null;
        const lead = claims.stripUngroundedClaims(cleanNarrative(a.text)) || (title ? `${title} isn’t something this demo can do.` : UNSUPPORTED_FALLBACK);
        const tail = title ? ` (See: ${title}.)` : '';
        return finish('unsupported', note(`${lead}${tail} Nothing was changed.`));
      }
    } catch (error) {
      telemetry.event('agent_error', { kind: error instanceof Error ? error.name : 'unknown' });
      decide('error');
      return finish('provider_unavailable', note('Something went wrong on my side before I could finish, so I haven’t changed anything. Please try again.', 'failed'));
    }
    })();

    // Final response summary (telemetry only): outcome, reply size, grounding drops, budgets used and the decision trail.
    if (decision.at(-1) !== result.outcome) decide(result.outcome);
    let trail = decision.join('→');
    if (trail.length > DECISION_MAX) trail = `${trail.slice(0, DECISION_MAX - 3)}...`;
    const reply = result.messages[0];
    const summary: Attrs = {
      outcome: result.outcome, ...(reply ? { status: reply.status } : {}),
      replyChars: result.messages.reduce((n, m) => n + m.text.length, 0), groundingDrops: drops.n,
      evidenceCount: result.messages.filter(m => m.evidence !== undefined).length,
      providerCalls, repairs, escalationCount: escalations, toolCalls, totalMs: Math.max(0, clock.now() - turnStartedAt), decision: trail,
    };
    try { telemetry.event('response', summary); } catch { /* telemetry never changes a turn */ }
    annotate({ decision: trail, groundingDrops: drops.n, providerCalls, repairs, escalationCount: escalations, toolCalls });
    return result;
  }

  return { handleTurn };
}
