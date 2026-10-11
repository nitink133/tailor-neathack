// Real Tailor runtime observability (NIT-273), built on the pinned neatlogs SDK (init/trace/flush/shutdown).
// Synthetic demo traces never go through here. Defaults to no network: only mode 'neatlogs' with an explicit
// apiKey from the composition root exports. Exported attributes are allowlisted; correlation IDs are opaque.
// Delivery is observable: SDK export failures/drops are folded into diagnostics(), flush()/shutdown() report a verdict
// (never `ok` after a rejected batch) and shutdown is bounded. Spans are batched (SDK default 5 s), so SIGKILL, a crash or
// any exit that bypasses shutdown() loses the current batch; graceful SIGINT/SIGTERM via main.ts flushes it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { init, trace, flush as sdkFlush, shutdown as sdkShutdown, getDeliveryDiagnostics, type MaskFunction, type TraceOptions, type TraceSpanKind } from 'neatlogs';
// Transitive dependency of neatlogs (hoisted); used only for the caller-owned local provider and exporters.
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
// Same transitive-dependency rule: the OTel global error handler is the only place background batch failures surface.
import { setGlobalErrorHandler, loggingErrorHandler } from '@opentelemetry/core';
import type { Span as OtelSpan } from '@opentelemetry/api';
import { LIMITS, type ProviderErrorKind, type ProviderUsage, type TelemetryStep, type TurnTelemetry } from './agent-contract.ts';

export type TelemetryMode = 'disabled' | 'captured' | 'neatlogs';
export interface TelemetryOptions {
  mode: TelemetryMode;
  /** Server-side secret for opaque correlation IDs (never exported). */
  secret: string;
  endpoint?: string;
  apiKey?: string;
  /** captured mode only: replaces the default no-op success exporter (tests inject failing exporters). */
  exporter?: SpanExporter;
  /** neatlogs mode: seconds between background batch exports (SDK default 5). */
  flushIntervalSeconds?: number;
  /** Upper bound for an explicit `flush()` (default 10 000 ms). */
  flushTimeoutMs?: number;
  /** Upper bound for the whole `shutdown()` (final flush + SDK shutdown; default 5 000 ms). */
  shutdownTimeoutMs?: number;
  /** One bounded line per failure burst / failed shutdown goes here (default: stderr). Never receives payloads or keys. */
  log?: (line: string) => void;
}
export interface CapturedSpan {
  name: string; traceId: string; spanId: string; parentSpanId: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status: { code: number; message?: string };
}
/**
 * Delivery health. `unknown`: nothing has been confirmed delivered yet (a flush or shutdown confirms; background
 * batches alone do not). `healthy`: confirmed delivery and no loss. `degraded`: delivering again (or no confirmed
 * delivery yet) but spans were lost earlier. `failing`: the most recent export failed and nothing has succeeded since.
 */
export type DeliveryState = 'disabled' | 'captured' | 'healthy' | 'degraded' | 'failing' | 'unknown';
/** Safe summary of the last export failure: HTTP status / error code / error class name only, never bodies or messages. */
export interface ExportErrorSummary { name: string | null; code: string | null; status: number | null; at: string }
/** turnId → opaque correlation id (HMAC of the session id) for the operator; the HMAC secret is never included. */
export interface TurnCorrelation { turnId: string; correlationId: string; status: 'ok' | 'failed' | null; outcome: string | null }
export interface TelemetryDiagnostics {
  mode: TelemetryMode;
  deliveryState: DeliveryState;
  droppedSteps: number; droppedAttributes: number; sdkFailures: number;
  /** neatlogs: spans the SDK failed to export; captured: failed exporter calls (after bounded retries). */
  exportFailures: number;
  /** Alias of `droppedSpans` kept for existing readers. */
  droppedExports: number;
  /** Spans dropped before export (bounded queue full / masked away). */
  droppedSpans: number;
  /** Spans waiting in the batch queue; null when the SDK queue cannot be inspected (unavailable, not zero). */
  queued: number | null;
  /** Spans estimated delivered (ended − failed − dropped, settled at each flush). */
  exportedSpans: number;
  lastExportError: ExportErrorSummary | null;
  lastSuccessfulExportAt: string | null;
  /** Last 20 turns, oldest first. */
  recentTurns: TurnCorrelation[];
}
/**
 * `flush()` outcome. An object is always truthy: callers MUST read `.ok`.
 * `ok` is false when any export failed or was dropped since the previous flush, when a failure is still unresolved
 * (an empty second flush after a rejected batch is NOT recovery), or when the flush timed out.
 */
export interface FlushResult { ok: boolean; exported: number; failed: number; state: DeliveryState; timedOut: boolean }
/** Final `shutdown()` outcome (same shape as a flush). SIGKILL / a crash skips this entirely and loses the current batch. */
export type ShutdownResult = FlushResult;
export interface Telemetry {
  readonly mode: TelemetryMode;
  forTurn(turnId: string, sessionId: string): TurnTelemetry;
  flush(): Promise<FlushResult>;
  /** Bounded final flush + SDK shutdown; idempotent; never throws. */
  shutdown(): Promise<ShutdownResult>;
  /** captured mode only: spans recorded locally (bounded); empty otherwise. */
  captured(): CapturedSpan[];
  diagnostics(): TelemetryDiagnostics;
}

const STEP_KINDS: Record<TelemetryStep, TraceSpanKind> = {
  turn: 'WORKFLOW', load_context: 'CHAIN', retrieve_knowledge: 'RETRIEVER', model: 'CHAIN', validate: 'GUARDRAIL',
  save: 'TOOL', readback: 'TOOL', explain: 'CHAIN', repair: 'CHAIN', escalate: 'CHAIN',
};
const ALLOWED_KEYS = new Set([
  'turnId', 'correlationId', 'outcome', 'step', 'status', 'durationMs', 'latencyMs', 'version', 'expectedVersion',
  'attemptedVersion', 'currentVersion', 'lastKnownVersion', 'conversationVersion', 'provider', 'providerMode', 'mode',
  'model', 'errorCode', 'code', 'reason', 'state', 'action', 'attempt', 'repairs', 'escalated', 'httpStatus',
]);
const COUNT_KEY = /^[a-z][A-Za-z]{0,40}(Count|Calls|Records|Spans|Traces|Problems|Tokens)$/;
/** Numeric-only keys (deadlines, reservations): `deadlineMs`, `reservationUsd`, `spentUsd`, ... Never strings. */
const MEASURE_KEY = /^[a-z][A-Za-z]{0,40}(Usd|Ms)$/;
// Provider-error detail (L4-10). Each key has its own value validator so these can never carry free text.
const PROVIDER_ERROR_KINDS = new Set<ProviderErrorKind>([
  'auth', 'permission', 'billing', 'spend_cap', 'rate_limit', 'overloaded', 'timeout', 'network',
  'invalid_request', 'refusal', 'truncated', 'malformed', 'context_exceeded', 'unknown',
]);
const VALIDATED: Record<string, (v: unknown) => boolean> = {
  providerErrorKind: v => typeof v === 'string' && PROVIDER_ERROR_KINDS.has(v as ProviderErrorKind),
  requestId: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  stopReason: v => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v),
  retryable: v => typeof v === 'boolean',
};
/** Names service code already uses → the allowlisted key (kind → provider_error_kind, providerRequestId → request_id). */
const KEY_ALIAS: Record<string, string> = { kind: 'providerErrorKind', providerRequestId: 'requestId' };
const SAFE_STRING = /^[A-Za-z0-9_.:\/-]{0,64}$/;
const SAFE_EVENT = /^[a-z0-9_.-]{1,48}$/i;
/** SDK structural keys that may pass the export mask; anything carrying payload/content is denied. */
const SDK_KEY = /^(neatlogs\.|openinference\.span\.kind$|session\.id$|service\.name$|telemetry\.sdk\.|_span_name$)/;
const PAYLOAD_KEY = /(input|output|prompt|message|content|exception|retriever|parameters|end_?user|user\.|metadata|template|variables|document|query)/i;
const TURN_OUTCOMES = new Set(['answered', 'clarification', 'committed', 'rejected', 'save_failed', 'readback_uncertain', 'conflict', 'unsupported', 'refused', 'expired', 'provider_unavailable']);

type AttrValue = string | number | boolean;
const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const safeValue = (v: unknown): v is AttrValue => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && SAFE_STRING.test(v));

/** Allowlist for caller-supplied attributes: known keys/count keys with short token-like values only. */
export function cleanAttributes(attrs: Record<string, unknown> | undefined): { clean: Record<string, AttrValue>; dropped: number } {
  const clean: Record<string, AttrValue> = {};
  let dropped = 0;
  for (const [rawKey, v] of Object.entries(attrs ?? {})) {
    const k = KEY_ALIAS[rawKey] ?? rawKey;
    const validator = VALIDATED[k];
    const measureOk = MEASURE_KEY.test(k) && typeof v === 'number' && v >= 0;
    const keyOk = validator ? validator(v) : ALLOWED_KEYS.has(k) || measureOk || (COUNT_KEY.test(k) && typeof v === 'number');
    if (keyOk && safeValue(v)) clean[`tailor.${snake(k)}`] = v; else dropped++;
  }
  return { clean, dropped };
}
function exportable(key: string, value: unknown): boolean {
  if (key.startsWith('tailor.')) return safeValue(value);
  if (!SDK_KEY.test(key) || PAYLOAD_KEY.test(key)) return false;
  return (typeof value === 'string' && value.length <= 200 && !/\s{2,}|[<>`]/.test(value)) || typeof value === 'number' || typeof value === 'boolean';
}
const filterAttrs = (attrs: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(attrs ?? {}).filter(([k, v]) => exportable(k, v)));

/** Defence-in-depth export mask: only allowlisted attributes and Tailor events survive; status text is dropped. */
export const maskSpanData: MaskFunction = (data) => {
  const events = Array.isArray(data.events) ? data.events : [];
  return {
    ...data,
    attributes: filterAttrs(data.attributes),
    events: events.filter((e: { name?: unknown }) => typeof e?.name === 'string' && e.name.startsWith('tailor.')).map((e: { attributes?: Record<string, unknown> }) => ({ ...e, attributes: filterAttrs(e.attributes) })),
    status: data.status ? { ...data.status, description: null } : data.status,
  };
};

export const correlationIdFor = (secret: string, sessionId: string) => createHmac('sha256', secret).update(sessionId).digest('hex').slice(0, 16);

/** Error passed through the SDK in place of the real one, so recorded exceptions carry only a safe code. */
class StepFailed extends Error { constructor(code: string) { super(code); this.name = 'StepFailed'; } }
const errorCodeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'step_failed';
};

type ExportCallback = Parameters<SpanExporter['export']>[1];
/** Bounded pending queue + bounded retries around any exporter; exporter throws never escape. */
class BoundedRetryExporter implements SpanExporter {
  inner: SpanExporter; pending = 0; failures = 0; dropped = 0; lastError: ExportErrorSummary | null = null;
  constructor(inner: SpanExporter) { this.inner = inner; }
  export(spans: ReadableSpan[], done: ExportCallback): void {
    if (this.pending + spans.length > LIMITS.telemetryQueueMax) { this.dropped += spans.length; done({ code: 1 }); return; }
    this.pending += spans.length;
    const finish = (code: 0 | 1, error?: Error) => {
      this.pending -= spans.length;
      if (code !== 0) { this.failures++; this.lastError = summarizeError(error); }
      try { done(error ? { code, error } : { code }); } catch { /* processor callback must not throw back */ }
    };
    const attempt = (n: number) => {
      try {
        this.inner.export(spans, result => {
          if (result.code === 0) finish(0);
          else if (n < LIMITS.telemetryExportRetries) attempt(n + 1);
          else finish(1, result.error);
        });
      } catch (e) {
        if (n < LIMITS.telemetryExportRetries) attempt(n + 1); else finish(1, e instanceof Error ? e : new Error('export failed'));
      }
    };
    attempt(0);
  }
  async shutdown() { try { await this.inner.shutdown(); } catch { /* ignore */ } }
  async forceFlush() { try { await this.inner.forceFlush?.(); } catch { /* ignore */ } }
}

/** Keeps the last N finished spans locally (captured mode) so tests can assert with zero network. */
class CaptureProcessor implements SpanProcessor {
  spans: CapturedSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    try {
      const ctx = span.spanContext();
      this.spans.push({
        name: span.name, traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: span.parentSpanId ?? null,
        attributes: { ...span.attributes },
        events: span.events.map(e => ({ name: e.name, attributes: { ...(e.attributes ?? {}) } })),
        status: { code: span.status.code, ...(span.status.message ? { message: span.status.message } : {}) },
      });
      if (this.spans.length > LIMITS.telemetryQueueMax) this.spans.shift();
    } catch { /* never throw from a processor */ }
  }
  async forceFlush() {}
  async shutdown() {}
}

/** Accepts and discards every span: captured mode keeps spans only in the bounded CaptureProcessor. */
const successExporter: SpanExporter = {
  export: (_spans, done) => done({ code: 0 }),
  shutdown: async () => {},
  forceFlush: async () => {},
};

/** Counts every span that ends in this provider (used to estimate `exported`). */
class SpanCounter implements SpanProcessor {
  ended = 0;
  onStart(): void {}
  onEnd(): void { this.ended++; }
  async forceFlush() {}
  async shutdown() {}
}

const RECENT_TURNS = 20;
/** Bounded turnId → correlationId log for the operator (the HMAC secret and raw session id are never stored). */
class TurnLog {
  private entries: TurnCorrelation[] = [];
  track(turnId: string, correlationId: string): TurnCorrelation {
    const safe = SAFE_STRING.test(turnId) ? turnId : 'invalid';
    const existing = this.entries.find(e => e.turnId === safe && e.correlationId === correlationId);
    if (existing) return existing;
    const entry: TurnCorrelation = { turnId: safe, correlationId, status: null, outcome: null };
    this.entries.push(entry);
    if (this.entries.length > RECENT_TURNS) this.entries.shift();
    return entry;
  }
  snapshot(): TurnCorrelation[] { return this.entries.map(e => ({ ...e })); }
}

/** Reduces any thrown/reported export error to class name + code/status. Messages and bodies are never read. */
function summarizeError(error: unknown): ExportErrorSummary {
  // The provider rejects with an array of per-processor errors; AggregateError carries `.errors`. Use the first entry.
  const first = Array.isArray(error) ? error[0] : Array.isArray((error as { errors?: unknown } | null)?.errors) ? (error as { errors: unknown[] }).errors[0] : error;
  const e = (first ?? {}) as { name?: unknown; code?: unknown; cause?: unknown };
  const c = e.code ?? (e.cause as { code?: unknown } | null | undefined)?.code;
  return {
    name: typeof e.name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : null,
    code: typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : null,
    status: typeof c === 'number' && Number.isInteger(c) && c >= 100 && c <= 599 ? c : null,
    at: new Date().toISOString(),
  };
}

type Settled = 'ok' | 'failed' | 'timeout';
/** Awaits `work` for at most `ms`; never throws, never leaves the timer running. */
async function bounded(work: Promise<unknown>, ms: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => 'ok' as const, () => 'failed' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, ms)); }),
    ]);
  } finally { clearTimeout(timer); }
}

const noopTurn = (turnId: string, correlationId: string): TurnTelemetry => ({
  turnId, correlationId,
  step: (_name, _attrs, fn) => fn(),
  event: () => {},
  recordUsage: () => {},
});
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

let active: Telemetry | null = null;

export async function createTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const { mode, secret } = options;
  if (typeof secret !== 'string' || !secret) throw new Error('Telemetry needs a non-empty server-side secret.');
  const log = options.log ?? ((line: string) => { try { console.error(line); } catch { /* stderr closed */ } });
  const turns = new TurnLog();
  if (mode === 'disabled') {
    const quiet: FlushResult = { ok: true, exported: 0, failed: 0, state: 'disabled', timedOut: false };
    return {
      mode,
      forTurn: (turnId, sessionId) => { const cid = correlationIdFor(secret, sessionId); turns.track(turnId, cid); return noopTurn(turnId, cid); },
      flush: async () => ({ ...quiet }), shutdown: async () => ({ ...quiet }), captured: () => [],
      diagnostics: () => ({
        mode, deliveryState: 'disabled', droppedSteps: 0, droppedAttributes: 0, sdkFailures: 0, exportFailures: 0, droppedExports: 0,
        droppedSpans: 0, queued: 0, exportedSpans: 0, lastExportError: null, lastSuccessfulExportAt: null, recentTurns: turns.snapshot(),
      }),
    };
  }
  if (mode !== 'captured' && mode !== 'neatlogs') throw new Error('Unknown telemetry mode.');
  if (mode === 'neatlogs' && !options.apiKey) throw new Error('Telemetry mode "neatlogs" needs an explicit apiKey from the composition root.');
  // The SDK keeps one module-level pipeline per process; a new instance replaces the previous one.
  if (active) await active.shutdown();

  const provider = new BasicTracerProvider();
  await init({
    disableExport: mode !== 'neatlogs',
    tracerProvider: provider,
    mask: maskSpanData,
    workflowName: 'tailor-agent',
    tags: ['tailor', 'runtime'],
    registerShutdownHandlers: false,
    ...(mode === 'neatlogs' ? {
      apiKey: options.apiKey,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.flushIntervalSeconds !== undefined ? { flushInterval: options.flushIntervalSeconds } : {}),
    } : {}),
  });
  // Added after init so they observe spans after the SDK processor has normalised attributes.
  const counter = new SpanCounter();
  provider.addSpanProcessor(counter);
  const capture = new CaptureProcessor();
  let exporter: BoundedRetryExporter | null = null;
  if (mode === 'captured') {
    exporter = new BoundedRetryExporter(options.exporter ?? successExporter);
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.addSpanProcessor(capture);
  }

  const diag = { droppedSteps: 0, droppedAttributes: 0, sdkFailures: 0 };
  const context = new AsyncLocalStorage<{ turnId: string; span: OtelSpan }>();
  const roots = new Map<string, OtelSpan>();
  let pending = 0;
  const guard = (fn: () => void) => { try { fn(); } catch { diag.sdkFailures++; } };
  const targetSpan = (turnId: string) => {
    const store = context.getStore();
    return store && store.turnId === turnId ? store.span : roots.get(turnId);
  };

  // ---- delivery accounting (neatlogs: SDK counters folded in; captured: BoundedRetryExporter) ----
  const sdkBase = (() => { const s = getDeliveryDiagnostics(); return { failed: s.spanExportFailures, dropped: s.spanQueueDrops + s.maskedSpanDrops }; })();
  let frozen: { failed: number; dropped: number; queued: number | null } | null = null;
  const queuedNow = (): number | null => {
    if (frozen) return frozen.queued;
    if (exporter) return exporter.pending;
    const processors = (provider as unknown as { _registeredSpanProcessors?: unknown })._registeredSpanProcessors;
    let total = 0; let seen = false;
    if (Array.isArray(processors)) {
      for (const p of processors) {
        const q = (p as { _finishedSpans?: unknown } | null)?._finishedSpans;
        if (Array.isArray(q)) { total += q.length; seen = true; }
      }
    }
    return seen ? total : null;
  };
  const totals = () => {
    if (frozen) return frozen;
    if (exporter) return { failed: exporter.failures, dropped: exporter.dropped };
    const s = getDeliveryDiagnostics();
    return { failed: s.spanExportFailures - sdkBase.failed, dropped: s.spanQueueDrops + s.maskedSpanDrops - sdkBase.dropped };
  };
  let failedAtSuccess = 0;       // failure counter when delivery was last confirmed; failed > this means "failing"
  let flushedFailed = 0;         // counters as of the previous flush (per-flush deltas)
  let flushedDropped = 0;
  let settledExported = 0;
  let lastError: ExportErrorSummary | null = null;
  let lastSuccessAt: string | null = null;
  let burstLogged = false;
  let closed = false;

  const stateNow = (): DeliveryState => {
    if (mode === 'captured') return 'captured';
    const t = totals();
    if (t.failed > failedAtSuccess) return 'failing';
    if (t.failed > 0 || t.dropped > 0) return 'degraded';
    return lastSuccessAt ? 'healthy' : 'unknown';
  };
  /** One bounded line per failure burst; a confirmed delivery ends the burst. `force`: an export error was just observed. */
  const logBurst = (force: boolean) => {
    if (mode !== 'neatlogs' || burstLogged) return;
    const t = totals();
    if (!force && t.failed <= failedAtSuccess && t.dropped === 0) return;
    burstLogged = true;
    const why = lastError?.status != null ? `status=${lastError.status}` : lastError?.code ? `code=${lastError.code}` : lastError?.name ? `error=${lastError.name}` : 'status=unknown';
    try { log(`[tailor:telemetry] export failing: ${why} failedSpans=${Math.max(0, t.failed)} droppedSpans=${Math.max(0, t.dropped)} (spans are not retried after a rejected batch)`); } catch { /* logging must not throw */ }
  };
  if (mode === 'neatlogs') {
    const noteError = (error: unknown) => {
      if (closed) return;
      lastError = summarizeError(error);
      setImmediate(() => logBurst(true)).unref();
    };
    // Background batch failures never reach the caller; the OTel global error handler is the only place they surface.
    setGlobalErrorHandler(noteError);
    // Explicit/shutdown flushes reject provider.forceFlush() (the SDK then logs and swallows it): observe it on our own provider.
    const forceFlush = provider.forceFlush.bind(provider);
    provider.forceFlush = async () => { try { await forceFlush(); } catch (error) { noteError(error); throw error; } };
  }

  const forTurn = (turnId: string, sessionId: string): TurnTelemetry => {
    const correlationId = correlationIdFor(secret, sessionId);
    const safeTurnId = SAFE_STRING.test(turnId) ? turnId : 'invalid';
    const summary = turns.track(turnId, correlationId);
    return {
      turnId, correlationId,
      async step<T>(name: TelemetryStep, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
        if (pending >= LIMITS.telemetryQueueMax) { diag.droppedSteps++; return fn(); }
        pending++;
        const box: { ran: boolean; result?: { ok: true; value: T } | { ok: false; error: unknown } } = { ran: false };
        try {
          const { clean, dropped } = cleanAttributes(attributes);
          diag.droppedAttributes += dropped;
          const attrs: Record<string, AttrValue> = { ...clean, 'tailor.turn_id': safeTurnId, 'tailor.correlation_id': correlationId, 'tailor.step': name };
          if (name === 'model') attrs['tailor.model_call'] = true;
          if (dropped) attrs['tailor.dropped_attributes'] = dropped;
          const traceOptions: TraceOptions = name === 'turn'
            ? { name: 'tailor.turn', kind: 'WORKFLOW', sessionId: correlationId, attributes: attrs }
            : { name: STEP_KINDS[name] ? name : 'step', kind: STEP_KINDS[name] ?? 'CHAIN', attributes: attrs };
          await trace(traceOptions, async (span) => {
            box.ran = true;
            const started = performance.now();
            if (name === 'turn') roots.set(turnId, span);
            try {
              const value = await context.run({ turnId, span }, fn);
              box.result = { ok: true, value };
              guard(() => {
                span.setAttribute('tailor.status', 'ok');
                const v = value as { outcome?: unknown; version?: unknown; conversationVersion?: unknown } | null;
                if (v && typeof v === 'object') {
                  if (typeof v.outcome === 'string' && TURN_OUTCOMES.has(v.outcome)) span.setAttribute('tailor.outcome', v.outcome);
                  if (typeof v.version === 'number' && Number.isFinite(v.version)) span.setAttribute('tailor.version', v.version);
                  if (typeof v.conversationVersion === 'number' && Number.isFinite(v.conversationVersion)) span.setAttribute('tailor.conversation_version', v.conversationVersion);
                }
              });
            } catch (error) {
              box.result = { ok: false, error };
              const code = errorCodeOf(error);
              guard(() => { span.setAttribute('tailor.status', 'failed'); span.setAttribute('tailor.error_code', code); });
              throw new StepFailed(code);
            } finally {
              guard(() => span.setAttribute('tailor.duration_ms', Math.round(performance.now() - started)));
              if (name === 'turn') roots.delete(turnId);
            }
          });
        } catch (e) {
          if (!(e instanceof StepFailed)) diag.sdkFailures++;
        } finally { pending--; }
        if (!box.ran || !box.result) return fn();
        if (name === 'turn') guard(() => {
          const r = box.result!;
          summary.status = r.ok ? 'ok' : 'failed';
          const o = r.ok ? (r.value as { outcome?: unknown } | null)?.outcome : undefined;
          summary.outcome = typeof o === 'string' && TURN_OUTCOMES.has(o) ? o : null;
        });
        if (box.result.ok) return box.result.value;
        throw box.result.error;
      },
      event(name: string, attributes: Record<string, string | number | boolean>) {
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          const { clean, dropped } = cleanAttributes(attributes);
          diag.droppedAttributes += dropped;
          span.addEvent(`tailor.${SAFE_EVENT.test(name) ? name : 'event'}`, clean);
        });
      },
      recordUsage(usage: ProviderUsage | null, model: string | null) {
        guard(() => {
          const span = targetSpan(turnId);
          if (!span) return;
          if (model !== null && SAFE_STRING.test(model)) span.setAttribute('tailor.model', model);
          if (!usage) { span.setAttribute('tailor.usage.available', false); return; }
          const ok = Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens);
          span.setAttribute('tailor.usage.available', ok);
          if (ok) {
            span.setAttribute('tailor.usage.input_tokens', usage.inputTokens); span.setAttribute('tailor.usage.output_tokens', usage.outputTokens);
            // Optional provider-reported detail; absent means not reported (never written as zero).
            if (Number.isFinite(usage.cacheReadInputTokens)) span.setAttribute('tailor.usage.cache_read_input_tokens', usage.cacheReadInputTokens as number);
            if (Number.isFinite(usage.cacheCreationInputTokens)) span.setAttribute('tailor.usage.cache_creation_input_tokens', usage.cacheCreationInputTokens as number);
            if (Number.isFinite(usage.thinkingTokens)) span.setAttribute('tailor.usage.thinking_tokens', usage.thinkingTokens as number);
          }
        });
      },
    };
  };

  /**
   * Flush + judge. Snapshots delivery counters around the flush: success is never reported when failures or drops
   * increased, nor while an earlier failure is unresolved (the failed batch is gone, so an empty re-flush proves nothing).
   * There is deliberately no flush retry loop: the OTLP transport already retries 429/5xx, and a rejected batch cannot be re-sent.
   */
  const doFlush = async (timeoutMs: number): Promise<FlushResult> => {
    const endedAtStart = counter.ended;
    let sdkOk = true;
    const work = (async () => {
      try { if (!(await sdkFlush())) sdkOk = false; } catch { diag.sdkFailures++; sdkOk = false; }
      try { await provider.forceFlush(); } catch { diag.sdkFailures++; sdkOk = false; }
    })();
    const timedOut = (await bounded(work, timeoutMs)) === 'timeout';
    const t = totals();
    const failed = Math.max(0, t.failed - flushedFailed);
    const dropped = Math.max(0, t.dropped - flushedDropped);
    flushedFailed = t.failed; flushedDropped = t.dropped;
    let exported = 0;
    if (!timedOut) {
      const total = Math.max(0, endedAtStart - t.failed - t.dropped);
      exported = Math.max(0, total - settledExported);
      settledExported = Math.max(settledExported, total);
    }
    const clean = sdkOk && !timedOut && failed === 0 && dropped === 0;
    const recovers = clean && exported > 0;
    const unresolved = mode === 'neatlogs' && t.failed > failedAtSuccess;
    const ok = clean && (!unresolved || recovers);
    if (recovers && mode === 'neatlogs') { failedAtSuccess = t.failed; burstLogged = false; }
    if (ok && exported > 0) lastSuccessAt = new Date().toISOString();
    logBurst(false);
    return { ok, exported, failed, state: stateNow(), timedOut };
  };

  const doShutdown = async (): Promise<ShutdownResult> => {
    const budget = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const left = () => Math.max(250, deadline - Date.now());
    const fl = await doFlush(budget);
    let timedOut = fl.timedOut;
    let shutdownOk = true;
    let sdkResult: unknown = true;
    const sdkOutcome = await bounded(sdkShutdown('tailor-telemetry-shutdown', left()).then(r => { sdkResult = r; }), left() + 500);
    if (sdkOutcome === 'timeout') timedOut = true;
    if (sdkOutcome !== 'ok') { shutdownOk = false; if (sdkOutcome === 'failed') diag.sdkFailures++; }
    if (sdkResult === false) shutdownOk = false;
    const providerOutcome = await bounded(provider.shutdown(), left() + 500);
    if (providerOutcome === 'timeout') timedOut = true;
    if (providerOutcome !== 'ok') { shutdownOk = false; if (providerOutcome === 'failed') diag.sdkFailures++; }
    const t = totals();
    const extraFailed = Math.max(0, t.failed - flushedFailed);
    const extraDropped = Math.max(0, t.dropped - flushedDropped);
    if (extraFailed > 0) logBurst(false);
    frozen = { failed: t.failed, dropped: t.dropped, queued: queuedNow() };
    closed = true;
    if (mode === 'neatlogs') setGlobalErrorHandler(loggingErrorHandler());
    if (active === telemetry) active = null;
    const result: ShutdownResult = {
      ok: fl.ok && shutdownOk && !timedOut && extraFailed === 0 && extraDropped === 0,
      exported: fl.exported, failed: fl.failed + extraFailed, state: stateNow(), timedOut,
    };
    if (!result.ok && mode === 'neatlogs') {
      try { log(`[tailor:telemetry] shutdown: delivery state=${result.state} exported=${result.exported} failed=${result.failed} totalFailedSpans=${t.failed} droppedSpans=${t.dropped}${result.timedOut ? ' timedOut=true' : ''}`); } catch { /* logging must not throw */ }
    }
    return result;
  };

  let shutdownPromise: Promise<ShutdownResult> | null = null;
  const telemetry: Telemetry = {
    mode,
    forTurn,
    flush: () => {
      if (shutdownPromise) return shutdownPromise;
      return doFlush(options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS).catch(() => ({ ok: false, exported: 0, failed: 0, state: stateNow(), timedOut: false }));
    },
    shutdown: () => (shutdownPromise ??= doShutdown().catch(() => ({ ok: false, exported: 0, failed: 0, state: stateNow(), timedOut: false }))),
    captured: () => capture.spans.map(s => structuredClone(s)),
    diagnostics: () => {
      const t = totals();
      if (!closed) logBurst(false);
      return {
        mode, deliveryState: stateNow(), ...diag,
        exportFailures: t.failed, droppedExports: t.dropped, droppedSpans: t.dropped,
        queued: queuedNow(), exportedSpans: settledExported,
        lastExportError: exporter?.lastError ?? lastError, lastSuccessfulExportAt: lastSuccessAt,
        recentTurns: turns.snapshot(),
      };
    },
  };
  active = telemetry;
  return telemetry;
}
