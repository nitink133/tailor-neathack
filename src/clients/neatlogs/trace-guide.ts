import type { Span, Trace } from './contracts.ts';

export function traceGuideFacts(trace: Trace): { steps: number; stepErrors: number; detections: number; recommendedSpan?: Span; outputSummary: string } {
  const errors = trace.spans.filter(span => span.status === 'ERROR');
  const output = trace.output;
  const outcome = output && typeof output === 'object' && !Array.isArray(output) && typeof output.outcome === 'string' ? output.outcome.trim() : '';
  return {
    steps: trace.spans.length,
    stepErrors: errors.length,
    detections: trace.spans.filter(span => span.detection).length,
    recommendedSpan: errors[0] ?? trace.spans.find(span => span.parentId === null) ?? trace.spans[0],
    outputSummary: outcome ? `Reported outcome: ${outcome.length > 90 ? outcome.slice(0, 89) + '…' : outcome}` : 'Open to inspect output',
  };
}

/** Recommend from the visible list only; never link to a trace excluded by its filters. */
export function recommendedTrace(traces: Trace[], activeScenario: string): Trace | undefined {
  return traces.find(trace => trace.spans.some(span => span.status === 'ERROR'))
    ?? traces.find(trace => trace.scenario === activeScenario)
    ?? traces[0];
}

/** Return only saved ancestors of this selected step, bounded even for bad cycles. */
export function selectedSpanAncestors(trace: Trace, selectedId: string): string[] {
  const spans = new Map(trace.spans.map(span => [span.id, span]));
  let selected = spans.get(selectedId);
  const visited = new Set([selectedId]);
  const ancestors: string[] = [];
  while (selected?.parentId && !visited.has(selected.parentId)) {
    const parent = spans.get(selected.parentId);
    if (!parent) break;
    visited.add(parent.id);
    ancestors.push(parent.id);
    selected = parent;
  }
  return ancestors;
}
