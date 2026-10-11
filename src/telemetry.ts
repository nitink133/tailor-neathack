// Real Tailor runtime observability (NIT-273), built on the pinned neatlogs SDK (init/trace/flush/shutdown).
// Synthetic demo traces never go through here. Defaults to no network: only mode 'neatlogs' with an explicit
// apiKey from the composition root exports. Exported attributes are allowlisted; correlation IDs are opaque.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { init, trace, flush as sdkFlush, shutdown as sdkShutdown, type MaskFunction, type TraceOptions, type TraceSpanKind } from 'neatlogs';
// Transitive dependency of neatlogs (hoisted); used only for the caller-owned local provider and exporters.
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Span as OtelSpan } from '@opentelemetry/api';
import { LIMITS, type ProviderUsage, type TelemetryStep, type TurnTelemetry } from './agent-contract.ts';

export type TelemetryMode = 'disabled' | 'captured' | 'neatlogs';
export interface TelemetryOptions {
  mode: TelemetryMode;
  /** Server-side secret for opaque correlation IDs (never exported). */
  secret: string;
  endpoint?: string;
  apiKey?: string;
  /** captured mode only: replaces the in-memory exporter (tests inject failing exporters). */
  exporter?: SpanExporter;
}
export interface CapturedSpan {
  name: string; traceId: string; spanId: string; parentSpanId: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status: { code: number; message?: string };
}
export interface TelemetryDiagnostics { droppedSteps: number; droppedAttributes: number; sdkFailures: number; exportFailures: number; droppedExports: number }
export interface Telemetry {
  readonly mode: TelemetryMode;
  forTurn(turnId: string, sessionId: string): TurnTelemetry;
  flush(): Promise<boolean>;
  shutdown(): Promise<void>;
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
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const keyOk = ALLOWED_KEYS.has(k) || (COUNT_KEY.test(k) && typeof v === 'number');
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
  inner: SpanExporter; pending = 0; failures = 0; dropped = 0;
  constructor(inner: SpanExporter) { this.inner = inner; }
  export(spans: ReadableSpan[], done: ExportCallback): void {
    if (this.pending + spans.length > LIMITS.telemetryQueueMax) { this.dropped += spans.length; done({ code: 1 }); return; }
    this.pending += spans.length;
    const finish = (code: 0 | 1, error?: Error) => {
      this.pending -= spans.length;
      if (code !== 0) this.failures++;
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

const noopTurn = (turnId: string, correlationId: string): TurnTelemetry => ({
  turnId, correlationId,
  step: (_name, _attrs, fn) => fn(),
  event: () => {},
  recordUsage: () => {},
});
const emptyDiagnostics = (): TelemetryDiagnostics => ({ droppedSteps: 0, droppedAttributes: 0, sdkFailures: 0, exportFailures: 0, droppedExports: 0 });

let active: Telemetry | null = null;

export async function createTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const { mode, secret } = options;
  if (typeof secret !== 'string' || !secret) throw new Error('Telemetry needs a non-empty server-side secret.');
  if (mode === 'disabled') {
    return {
      mode, forTurn: (turnId, sessionId) => noopTurn(turnId, correlationIdFor(secret, sessionId)),
      flush: async () => true, shutdown: async () => {}, captured: () => [], diagnostics: emptyDiagnostics,
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
    ...(mode === 'neatlogs' ? { apiKey: options.apiKey, ...(options.endpoint ? { endpoint: options.endpoint } : {}) } : {}),
  });
  // Added after init so they observe spans after the SDK processor has normalised attributes.
  const capture = new CaptureProcessor();
  let exporter: BoundedRetryExporter | null = null;
  if (mode === 'captured') {
    exporter = new BoundedRetryExporter(options.exporter ?? new InMemorySpanExporter());
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.addSpanProcessor(capture);
  }

  const diag = emptyDiagnostics();
  const context = new AsyncLocalStorage<{ turnId: string; span: OtelSpan }>();
  const roots = new Map<string, OtelSpan>();
  let pending = 0;
  const guard = (fn: () => void) => { try { fn(); } catch { diag.sdkFailures++; } };
  const targetSpan = (turnId: string) => {
    const store = context.getStore();
    return store && store.turnId === turnId ? store.span : roots.get(turnId);
  };

  const forTurn = (turnId: string, sessionId: string): TurnTelemetry => {
    const correlationId = correlationIdFor(secret, sessionId);
    const safeTurnId = SAFE_STRING.test(turnId) ? turnId : 'invalid';
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
          if (ok) { span.setAttribute('tailor.usage.input_tokens', usage.inputTokens); span.setAttribute('tailor.usage.output_tokens', usage.outputTokens); }
        });
      },
    };
  };

  let closed = false;
  const telemetry: Telemetry = {
    mode,
    forTurn,
    async flush() {
      for (let attempt = 0; attempt <= LIMITS.telemetryExportRetries; attempt++) {
        try {
          const ok = await sdkFlush();
          await provider.forceFlush();
          if (ok) return true;
        } catch { diag.sdkFailures++; }
      }
      return false;
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      try { await sdkShutdown('tailor-telemetry-shutdown'); } catch { diag.sdkFailures++; }
      try { await provider.shutdown(); } catch { diag.sdkFailures++; }
      if (active === telemetry) active = null;
    },
    captured: () => capture.spans.map(s => structuredClone(s)),
    diagnostics: () => ({ ...diag, exportFailures: exporter?.failures ?? 0, droppedExports: exporter?.dropped ?? 0 }),
  };
  active = telemetry;
  return telemetry;
}
