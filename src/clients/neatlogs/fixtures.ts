import type { Dataset, FixtureScenario, Json, Span, Trace } from './contracts.ts';

// NIT-265 regression fixtures. Kept as baselines; personalised data is validated by the schema/coherence
// validator (NIT-273), not by equality with these two records.
export function fixtures(sessionId: string, activeScenario: FixtureScenario = 'recovered'): Dataset {
  const traces = (['recovered', 'exhausted'] as const).map((scenario): Trace => {
    const prefix = `${sessionId}-${scenario}`;
    const rootId = `${prefix}-root`;
    const recovered = scenario === 'recovered';
    const order = recovered ? 'SYN-ORDER-103' : 'SYN-ORDER-106';
    const input: Json = { scenario, synthetic: true, orderId: order };
    const output: Json = recovered
      ? { outcome: 'order_found', orderId: order, status: 'shipped', totalCents: 2600, currency: 'USD', synthetic: true }
      : { outcome: 'escalation_required', reason: 'lookup_timeout_exhausted', orderId: order, message: 'Both lookup attempts failed. Please ask your support team to review this fictional order. No ticket was sent.', ticketSent: false, synthetic: true };
    const step = (suffix: string, name: string, kind: Span['kind'], startMs: number, durationMs: number, status: Span['status'], input: Json, output: Json): Span => ({
      id: `${prefix}-${suffix}`, parentId: rootId, name, kind, startMs, durationMs, status, input, output,
      error: status === 'ERROR' ? 'SYNTHETIC: order lookup timed out after 20 ms' : null,
      detection: !recovered && status === 'ERROR',
    });
    const spans: Span[] = [
      { id: rootId, parentId: null, name: `SYNTHETIC order-lookup-${scenario}`, kind: 'WORKFLOW', startMs: 0, durationMs: recovered ? 43 : 51, status: 'OK', input, output, error: null, detection: false },
      step('validate', 'validate_request', 'GUARDRAIL', 1, 2, 'OK', { orderId: order }, { valid: true }),
      step('attempt-1', 'lookup_order_attempt_1', 'TOOL', 4, 23, 'ERROR', { orderId: order, attempt: 1 }, null),
      step('attempt-2', 'lookup_order_attempt_2', 'TOOL', 28, recovered ? 8 : 21, recovered ? 'OK' : 'ERROR', { orderId: order, attempt: 2 }, recovered ? { orderId: order, status: 'shipped', totalCents: 2600, currency: 'USD' } : null),
      ...(recovered ? [step('verify', 'verify_order_result', 'GUARDRAIL', 37, 4, 'OK', { orderId: order }, { verified: true })] : []),
      step('answer', recovered ? 'prepare_order_answer' : 'prepare_escalation', 'CHAIN', recovered ? 42 : 50, 0.37, 'OK', { synthetic: true }, output),
    ];
    return { id: prefix, sessionId, scenario, label: recovered ? 'Retry recovers' : 'Both attempts fail', name: 'SYNTHETIC Tailor Demo Order Support', ingestedAt: '2026-10-10T18:17:00.000Z', status: 'Ready', outcome: recovered ? 'order_found' : 'escalation_required', outcomeKind: recovered ? 'success' : 'escalation', tags: ['synthetic', 'tailor-demo', scenario], input, output, spans };
  });
  return { activeScenario, traces };
}

export { validateDataset } from './validator.ts';
