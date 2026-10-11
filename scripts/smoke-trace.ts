// SYNTHETIC smoke trace: no model calls, no user data. Sends one labelled
// WORKFLOW + TOOL trace, then reads it back by ID. Never prints the key.
import { init, trace, span, setTraceOutput, flush, shutdown } from 'neatlogs';

const apiKey = process.env.NEATLOGS_API_KEY;
if (!apiKey) {
  console.error('NEATLOGS_API_KEY missing; set it in .env.local or the shell.');
  process.exit(2);
}
const origin = new URL(process.env.NEATLOGS_ENDPOINT?.trim() || 'https://ingest.neatlogs.com').origin;

await init({
  apiKey,
  workflowName: 'tailor-synthetic-smoke',
  tags: ['synthetic', 'smoke-test'],
  metadata: { synthetic: true, source: 'scripts/smoke-trace.ts' },
});

const echo = span({ kind: 'TOOL', toolName: 'synthetic_echo' }, async (text: string) => ({ echo: text }));

let traceId = '';
try {
  await trace({ name: 'tailor.synthetic.smoke', kind: 'WORKFLOW', input: { synthetic: true } }, async (active) => {
    traceId = active.spanContext().traceId;
    const out = await echo('synthetic smoke test');
    setTraceOutput(out);
    return out;
  });
} finally {
  console.log(JSON.stringify({ flushed: await flush(), shutdown: await shutdown() }));
}
console.log(JSON.stringify({ synthetic: true, trace_id: traceId, origin }));

const deadline = Date.now() + 60_000;
let result: Record<string, unknown> = { visible: false };
while (Date.now() < deadline) {
  const res = await fetch(`${origin}/api/traces/v3/${encodeURIComponent(traceId)}`, {
    headers: { 'x-api-key': apiKey },
    redirect: 'error',
  });
  if (res.ok && res.status !== 202) {
    const body: any = await res.json();
    const spans: any[] = body?.spans ?? [];
    result = {
      visible: true,
      http_status: res.status,
      readback_trace_id: body?._id ?? null,
      trace_id_matches: body?._id === traceId,
      project_id: body?.projectId ?? null,
      status: body?.status ?? null,
      span_count: spans.length,
      spans: spans.map((s) => ({ name: s?.node_name, type: s?.node_type, span_id: s?.span_id, parent: s?.parent_span_id ?? null })),
    };
    break;
  }
  result = { visible: false, http_status: res.status };
  if (res.status === 401 || res.status === 403) break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(JSON.stringify({ readback: result }));
process.exit(result.visible ? 0 : 3);
