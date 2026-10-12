// Pure hosted-readback validation: no environment, credentials, network or model calls.
import { compareEvidence, evidenceKey, EVIDENCE_OPERATIONS, type EvidenceManifestSnapshot, type EvidenceReceipt } from '../tailor/evidence.ts';
import { looksSensitive, createSpanMask, telemetryVocabulary, isSafeTelemetryEventName } from './telemetry.ts';

export const RUNTIME_PROJECT_ID = '18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8';
export const FORBIDDEN_PROJECT_ID = 'a35a7334-258e-441c-b2e1-b8198a263f21';
export interface HostedExpectation {
  traceId: string;
  sessionId: string;
  turnRef: string;
  demoRef: string;
  requestRef: string;
  manifest: EvidenceManifestSnapshot;
  outcome?: string | null;
  version?: number;
  /** Code-owned required fields, supplied separately from received data. */
  requiredRootAttributes?: readonly string[];
  /** Exact code-approved fixture text; payloads are rejected without this opt-in. */
  synthetic?: { input?: string; output?: string };
}
export interface HostedVerification {
  ok: boolean;
  receiptState: 'unverified' | 'received_verified';
  issues: string[];
  rootCount: number;
  spanCount: number;
  completeness: ReturnType<typeof compareEvidence>;
}

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Bag : {};
/** Supports ordinary API attribute maps and decoded OTLP KeyValue arrays. */
export function attributeMap(value: unknown): Bag {
  if (!Array.isArray(value)) return bag(value);
  return Object.fromEntries(value.flatMap(entry => {
    const item = bag(entry); const v = bag(item.value);
    if (typeof item.key !== 'string') return [];
    return [[item.key, v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue]];
  }));
}
const spanId = (span: Bag): string | null => {
  const id = span.spanId ?? span.span_id ?? span.node_id ?? span._id ?? span.id;
  return typeof id === 'string' && id ? id : null;
};
const parentId = (span: Bag): string | null => {
  const id = span.parentSpanId ?? span.parent_span_id ?? span.parent_node_id ?? span.parentId;
  return typeof id === 'string' && id ? id : null;
};
const name = (span: Bag) => span.node_name ?? span.name;

/** Normalise the hosted projection without inferring missing evidence from names/counts. */
function normaliseHostedSpan(span: Bag, issues: string[]): Bag {
  const value = span.span_metadata;
  let metadata: Bag = {};
  if (typeof value === 'string') {
    if (value.length > 256_000) issues.push('metadata_limit');
    else try { metadata = bag(JSON.parse(value)); } catch { issues.push('invalid_metadata'); }
  } else metadata = bag(value);
  const envelope = bag(metadata.tailor);
  const mirrored = attributeMap(envelope.attributes);
  // Declarations remain bounded token identifiers. This validates shape/privacy, not authenticity;
  // exact turn/session/evidence expectations below provide the independent identity checks.
  const values = (key: string) => typeof mirrored[key] === 'string' ? [mirrored[key] as string] : [];
  const vocab = telemetryVocabulary({ adapterIds: values('tailor.adapter_id'), toolNames: [...values('tailor.tool_name'), ...(typeof mirrored['tailor.decision'] === 'string' ? mirrored['tailor.decision'].split('→').flatMap(part => part.match(/^([A-Za-z][A-Za-z0-9_]{0,47})(?::| |$)/)?.[1] ?? []) : [])],
    recordIds: (typeof mirrored['tailor.source_ids'] === 'string' ? mirrored['tailor.source_ids'].split(',') : []),
    promptVersions: values('tailor.prompt_version'), knowledgeVersions: values('tailor.knowledge_version'),
    codeVersions: values('tailor.code_version'), adapterVersions: values('tailor.adapter_version'), policyVersions: values('tailor.policy_version'),
    modelIds: [...values('tailor.model'), ...values('tailor.guard_model')], contractVersions: values('tailor.contract_version') });
  const events = Array.isArray(envelope.events) ? envelope.events.map(bag) : [];
  if (events.length > 200) issues.push('metadata_limit');
  if (events.some(e => !isSafeTelemetryEventName(e.name))) issues.push('unsafe_metadata');
  const sdk = bag(metadata.sdk);
  if (Object.keys(sdk).some(k => !['neatlogs.session.id','neatlogs.span.kind','openinference.span.kind'].includes(k))) issues.push('unsafe_metadata');
  if (sdk['neatlogs.session.id'] !== undefined && (typeof sdk['neatlogs.session.id'] !== 'string' || !/^[0-9a-f]{16}$/.test(sdk['neatlogs.session.id']))) issues.push('unsafe_metadata');
  for (const key of ['neatlogs.span.kind','openinference.span.kind']) if (sdk[key] !== undefined && (typeof sdk[key] !== 'string' || !/^(?:workflow|chain|guardrail|tool|retriever|llm|agent|Neatlogs.INTERNAL)$/i.test(sdk[key]))) issues.push('unsafe_metadata');
  const synthetic = bag(metadata.synthetic);
  for (const [key,value] of Object.entries(synthetic)) if (!['input','output'].includes(key) || typeof value !== 'string' || value.length > 1000 || looksSensitive(value)) issues.push('unsafe_synthetic_payload');
  const candidate = { attributes: { ...sdk, ...mirrored }, events };
  const safe = createSpanMask(vocab)(candidate) as { attributes: Bag; events: Bag[] };
  if (Object.keys(candidate.attributes).length !== Object.keys(safe.attributes).length || events.length !== safe.events.length) issues.push('unsafe_metadata');
  for (let i = 0; i < events.length; i++) if (Object.keys(attributeMap(events[i]?.attributes)).length !== Object.keys(attributeMap(safe.events[i]?.attributes)).length) issues.push('unsafe_metadata');
  if (Object.keys(metadata).some(k => !['tailor','sdk','synthetic'].includes(k)) || Object.keys(envelope).some(k => !['attributes','events'].includes(k))) issues.push('unsafe_metadata');
  const attributes = { ...safe.attributes, ...attributeMap(span.attributes) };
  const rawEvents = Array.isArray(span.events) ? span.events : null;
  return { ...span, attributes, events: rawEvents ?? safe.events, synthetic: bag(metadata.synthetic) };
}

/** Identity must be checked before any export is enabled. Absence is refusal, never an inferred project. */
export function verifyProjectIdentity(body: unknown): boolean {
  return bag(body).projectId === RUNTIME_PROJECT_ID;
}

/** A successful flush is deliberately not an input: only received trace contents can establish this verdict. */
export function verifyHostedTrace(body: unknown, expected: HostedExpectation): HostedVerification {
  const trace = bag(body); const issues: string[] = [];
  if (trace.projectId !== RUNTIME_PROJECT_ID) issues.push(trace.projectId === FORBIDDEN_PROJECT_ID ? 'forbidden_project' : 'project_mismatch');
  if ((trace._id ?? trace.traceId ?? trace.trace_id) !== expected.traceId) issues.push('trace_mismatch');
  const spans = Array.isArray(trace.spans) ? trace.spans.map(value => normaliseHostedSpan(bag(value), issues)) : [];
  const roots = spans.filter(span => name(span) === 'tailor.turn' && parentId(span) === null);
  if (roots.length !== 1) issues.push('turn_root_count');
  const workflowRoots = spans.filter(span => parentId(span) === null && attributeMap(span.attributes)['neatlogs.internal'] !== true && String(attributeMap(span.attributes)['neatlogs.span.kind'] ?? attributeMap(span.attributes)['openinference.span.kind'] ?? '').toLowerCase() === 'workflow');
  if (workflowRoots.length !== 1) issues.push('workflow_root_count');
  const ids = spans.map(spanId);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) issues.push('span_identity');
  const root = roots[0]; const rootAttrs = attributeMap(root?.attributes);
  if (rootAttrs['neatlogs.session.id'] !== expected.sessionId) issues.push('session_mismatch');
  for (const [key, value] of Object.entries({ 'tailor.turn_id': expected.turnRef, 'tailor.demo_ref': expected.demoRef, 'tailor.request_ref': expected.requestRef })) {
    if (rootAttrs[key] !== value) issues.push(`root_${key.replaceAll('.', '_')}_mismatch`);
  }
  if (expected.outcome && rootAttrs['tailor.outcome'] !== expected.outcome) issues.push('outcome_mismatch');
  if (expected.version !== undefined && rootAttrs['tailor.version'] !== expected.version) issues.push('version_mismatch');
  for (const key of expected.requiredRootAttributes ?? []) if (rootAttrs[key] === undefined) issues.push(`missing_${key.replaceAll('.', '_')}`);
  const synthetic = bag(root?.synthetic);
  if (Object.keys(synthetic).length) {
    if (!expected.synthetic || rootAttrs['tailor.synthetic'] !== true) issues.push('unexpected_synthetic_payload');
    if (Object.keys(synthetic).some(k => !['input','output'].includes(k))) issues.push('unsafe_metadata');
    for (const [key, value] of Object.entries(synthetic)) if (typeof value !== 'string' || value.length > 1000 || looksSensitive(value)) issues.push('unsafe_synthetic_payload');
  }
  if (expected.synthetic) for (const [key,value] of Object.entries(expected.synthetic)) if (synthetic[key] !== value) issues.push(`synthetic_${key}_mismatch`);
  const rootId = root ? spanId(root) : null;
  const byId = new Map(spans.map(span => [spanId(span), span]));
  for (const span of spans) {
    if (name(span) === 'neatlogs.trace.complete') continue;
    if (span !== root && Object.keys(bag(span.synthetic)).length) issues.push('unexpected_synthetic_payload');
    let parent = parentId(span); const visited = new Set<string>();
    while (parent && parent !== rootId) {
      if (visited.has(parent) || !byId.has(parent)) { issues.push('span_parentage'); break; }
      visited.add(parent); parent = parentId(byId.get(parent)!);
    }
    if (span !== root && parent !== rootId) issues.push('detached_span');
    const attrs = attributeMap(span.attributes);
    const eventAttributes = (Array.isArray(span.events) ? span.events.map(bag) : []).map(event => { if (typeof event.name === 'string' && !event.name.startsWith('tailor.')) issues.push('unsafe_event_name'); return attributeMap(event.attributes); });
    for (const [key, value] of [attrs, ...eventAttributes].flatMap(attribute => Object.entries(attribute))) {
      if (/^(?:input\.value|output\.value|exception\.|neatlogs\.(?:input|output|prompt|retriever|end_user\.metadata))/.test(key) || key.startsWith('tailor.synthetic_')) issues.push('payload_attribute');
      const knownTraceId = key === 'tailor.trace_id' && typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
      const knownCodeVersion = key === 'tailor.code_version' && typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value);
      if (!knownTraceId && !knownCodeVersion && looksSensitive(value)) issues.push('sensitive_attribute');
      if (typeof value === 'string' && key.startsWith('tailor.') && key !== 'tailor.decision' && /\s|[<>`]/.test(value)) issues.push('free_text_attribute');
    }
  }
  const receipts: EvidenceReceipt[] = [];
  for (const span of spans) for (const event of Array.isArray(span.events) ? span.events.map(bag) : []) {
    if (event.name !== 'tailor.evidence') continue;
    const attrs = attributeMap(event.attributes);
    const operation = attrs['tailor.operation']; const phase = attrs['tailor.evidence_phase']; const status = attrs['tailor.evidence_status']; const ordinal = Number(attrs['tailor.evidence_ordinal']);
    if (!EVIDENCE_OPERATIONS.includes(operation as never) || (phase !== 'start' && phase !== 'end') || !['ok', 'failed', 'cancelled', 'interrupted'].includes(String(status))) { issues.push('invalid_receipt'); continue; }
    try {
      const key = evidenceKey(operation as EvidenceReceipt['operation'], ordinal, phase);
      if (attrs['tailor.evidence_key'] !== key) { issues.push('invalid_receipt_key'); continue; }
      receipts.push({ key, operation: operation as EvidenceReceipt['operation'], ordinal, phase, status: status as EvidenceReceipt['status'] });
    } catch { issues.push('invalid_receipt_ordinal'); }
  }
  const completeness = compareEvidence(expected.manifest, receipts);
  if (expected.manifest.expected.length === 0) issues.push('expected_manifest_empty');
  if (!completeness.complete) issues.push('event_completeness');
  const ok = issues.length === 0;
  return { ok, receiptState: ok ? 'received_verified' : 'unverified', issues: [...new Set(issues)], rootCount: roots.length, spanCount: spans.length, completeness };
}

/** Injectable read seam lets offline tests exercise the verifier without importing an executable script. */
export async function readAndVerifyHostedTrace(read: (traceId: string) => Promise<unknown>, expected: HostedExpectation): Promise<HostedVerification> {
  return verifyHostedTrace(await read(expected.traceId), expected);
}
