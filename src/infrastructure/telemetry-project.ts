// Read-only identity check before the composition root creates an exporter. It performs no ingestion.
export const TAILOR_RUNTIME_PROJECT = '18c4b4b6-0b1e-4d41-9405-7960fc2d0aa8';
export const HOSTED_INGEST_ORIGIN = 'https://ingest.neatlogs.com';
export interface ProjectProbeConfig { apiKey: string; endpoint?: string; projectId: string; probeTraceId: string }
export async function verifyRuntimeProject(config: ProjectProbeConfig, read: typeof fetch = fetch): Promise<void> {
  if (config.projectId !== TAILOR_RUNTIME_PROJECT) throw new Error('Telemetry runtime project is not the approved Tailor project');
  const origin = new URL(config.endpoint ?? HOSTED_INGEST_ORIGIN).origin;
  if (origin !== HOSTED_INGEST_ORIGIN) throw new Error('Telemetry endpoint is not the verified hosted origin');
  if (!/^[0-9a-f]{32}$/.test(config.probeTraceId)) throw new Error('A previously approved Doctor trace ID is required before ingestion');
  const res = await read(`${origin}/api/traces/v3/${encodeURIComponent(config.probeTraceId)}`, { headers: { 'x-api-key': config.apiKey }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok || res.status === 202) throw new Error('Telemetry key project could not be verified; exporter was not initialized');
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || (data as { projectId?: unknown }).projectId !== TAILOR_RUNTIME_PROJECT) throw new Error('Telemetry key does not verify the approved Tailor runtime project');
}
