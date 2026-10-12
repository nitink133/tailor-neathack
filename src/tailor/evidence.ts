// Browser-safe evidence contract. Expectations come from business dispatch decisions, never from received spans.
// Contains only closed operation names, ordinals and outcomes; no buyer text, prompts, credentials or reasoning.
export const EVIDENCE_OPERATIONS = ['turn', 'load_context', 'context', 'retrieve_knowledge', 'model', 'repair', 'escalate', 'validate', 'tool', 'save', 'readback', 'explain', 'guard', 'response'] as const;
export type EvidenceOperation = typeof EVIDENCE_OPERATIONS[number];
export type EvidencePhase = 'start' | 'end';
export type EvidenceStatus = 'ok' | 'failed' | 'cancelled' | 'interrupted';
export type FailureKind = 'cancelled' | 'crashed' | 'expired';
export interface ExpectedEvidence { key: string; operation: EvidenceOperation; ordinal: number; phase: EvidencePhase }
export interface EvidenceReceipt extends ExpectedEvidence { status: EvidenceStatus }
export interface EvidenceManifestSnapshot {
  version: 1;
  expected: ExpectedEvidence[];
  observed: EvidenceReceipt[];
  interruption: FailureKind | null;
}
export interface EvidenceComparison {
  expected: number;
  observed: number;
  missing: string[];
  unexpected: string[];
  duplicates: string[];
  failed: string[];
  cancelled: string[];
  interruption: FailureKind | null;
  complete: boolean;
}
export interface EvidenceObserver {
  expect(operation: EvidenceOperation, ordinal?: number): void;
  observe(operation: EvidenceOperation, ordinal: number, phase: EvidencePhase, status: EvidenceStatus): void;
  interrupt(reason: FailureKind): void;
  snapshot(): EvidenceManifestSnapshot;
}

export function evidenceKey(operation: EvidenceOperation, ordinal: number, phase: EvidencePhase): string {
  if (!EVIDENCE_OPERATIONS.includes(operation) || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 10_000 || !['start', 'end'].includes(phase)) throw new Error('Invalid evidence identity');
  return `${operation}:${ordinal}:${phase}`;
}

/** Receipts may be local observations or independently read hosted events. Neither creates expectations. */
export function compareEvidence(manifest: EvidenceManifestSnapshot, received: readonly EvidenceReceipt[] = manifest.observed): EvidenceComparison {
  const expected = new Set(manifest.expected.map(e => e.key));
  const counts = new Map<string, number>();
  for (const r of received) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  const missing = [...expected].filter(key => !counts.has(key));
  const unexpected = [...counts.keys()].filter(key => !expected.has(key));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
  const failed = [...new Set(received.filter(r => r.status === 'failed' || r.status === 'interrupted').map(r => r.key))];
  const cancelled = [...new Set(received.filter(r => r.status === 'cancelled').map(r => r.key))];
  return { expected: expected.size, observed: received.length, missing, unexpected, duplicates, failed, cancelled, interruption: manifest.interruption, complete: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0 };
}

/** Restore only this safe shape. A malformed persisted manifest fails closed instead of manufacturing coverage. */
export function createEvidenceObserver(options: { manifest?: EvidenceManifestSnapshot; onChange?: (snapshot: EvidenceManifestSnapshot) => void; onReceipt?: (receipt: EvidenceReceipt) => void } = {}): EvidenceObserver {
  const expected = new Map<string, ExpectedEvidence>();
  const observed: EvidenceReceipt[] = [];
  let interruption: FailureKind | null = null;
  const snapshot = (): EvidenceManifestSnapshot => ({ version: 1, expected: [...expected.values()].map(e => ({ ...e })), observed: observed.map(e => ({ ...e })), interruption });
  const notify = () => options.onChange?.(snapshot());
  const validate = (e: ExpectedEvidence) => {
    if (!e || e.key !== evidenceKey(e.operation, e.ordinal, e.phase)) throw new Error('Invalid evidence manifest');
  };
  if (options.manifest) {
    const m = options.manifest;
    if (m.version !== 1 || !Array.isArray(m.expected) || !Array.isArray(m.observed) || m.expected.length > 2_000 || m.observed.length > 4_000) throw new Error('Invalid evidence manifest');
    if (m.interruption !== null && !['cancelled', 'crashed', 'expired'].includes(m.interruption)) throw new Error('Invalid evidence interruption');
    for (const e of m.expected) { validate(e); expected.set(e.key, { key: e.key, operation: e.operation, ordinal: e.ordinal, phase: e.phase }); }
    for (const e of m.observed) { validate(e); if (!['ok', 'failed', 'cancelled', 'interrupted'].includes(e.status)) throw new Error('Invalid evidence receipt'); observed.push({ key: e.key, operation: e.operation, ordinal: e.ordinal, phase: e.phase, status: e.status }); }
    interruption = m.interruption;
  }
  return {
    expect(operation, ordinal = 1) {
      if (expected.size >= 2_000) throw new Error('Evidence manifest capacity exceeded');
      for (const phase of ['start', 'end'] as const) { const key = evidenceKey(operation, ordinal, phase); expected.set(key, { key, operation, ordinal, phase }); }
      notify();
    },
    observe(operation, ordinal, phase, status) {
      if (!['ok', 'failed', 'cancelled', 'interrupted'].includes(status) || observed.length >= 4_000) throw new Error('Invalid evidence receipt');
      const receipt: EvidenceReceipt = { key: evidenceKey(operation, ordinal, phase), operation, ordinal, phase, status };
      observed.push(receipt); notify(); options.onReceipt?.({ ...receipt });
    },
    interrupt(reason) { if (!['cancelled', 'crashed', 'expired'].includes(reason)) throw new Error('Invalid evidence interruption'); interruption = reason; notify(); },
    snapshot,
  };
}
