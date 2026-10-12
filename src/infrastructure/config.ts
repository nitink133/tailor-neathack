// Environment parsing for the composition root. Reads plain environment variables only; never loads .env.local and
// never prints a secret. Every live-provider gate is checked BEFORE any network client exists.
import { dirname, join } from 'node:path';
import type { TelemetryMode } from './telemetry.ts';
import { maxOutputTokensFor, type ProviderConfig } from '../clients/neatlogs/provider.ts';
import { createSpendGuard, hasRatesFor, type SpendGuard } from '../tailor/spend.ts';
import { TAILOR_RUNTIME_PROJECT, HOSTED_INGEST_ORIGIN, type ProjectProbeConfig } from './telemetry-project.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

export interface ServerConfig {
  port: number;
  dataPath: string;
  ledgerPath: string;
  telemetryMode: TelemetryMode;
  neatlogs?: { apiKey: string | undefined; endpoint: string | undefined };
  telemetryProject?: ProjectProbeConfig;
  devKey: string | undefined;
  providerConfig: ProviderConfig;
  spend?: SpendGuard;
}

/** Parses the environment; `fail` reports a refusal and must not return (main.ts exits 2). */
export function readConfig(env: NodeJS.ProcessEnv, fail: (message: string) => never): ServerConfig {
  const port = Number(env.PORT ?? 4321);
  const dataPath = env.TAILOR_DATA_PATH ?? '.local/tailor.sqlite';
  /** The spend cap is enforced per ledger file; set it explicitly so moving the data path does not start a fresh total. */
  const ledgerPath = env.TAILOR_SPEND_LEDGER?.trim() || join(dirname(dataPath), 'spend-ledger.json');
  const providerKind = env.TAILOR_PROVIDER ?? 'mock';
  const telemetryMode = (env.TAILOR_TELEMETRY ?? 'captured') as TelemetryMode;

  if (providerKind !== 'mock' && providerKind !== 'anthropic') {
    fail(`TAILOR_PROVIDER=${providerKind} is not supported. Use "mock" (default, offline) or "anthropic" (approved live baseline).`);
  }
  if (!['disabled', 'captured', 'neatlogs'].includes(telemetryMode)) {
    fail(`TAILOR_TELEMETRY must be disabled, captured or neatlogs (got ${telemetryMode}).`);
  }
  if (telemetryMode === 'neatlogs' && !env.NEATLOGS_API_KEY) {
    fail('TAILOR_TELEMETRY=neatlogs needs NEATLOGS_API_KEY in the environment (external ingestion is a separate approval).');
  }
  let telemetryProject: ProjectProbeConfig | undefined;
  if (telemetryMode === 'neatlogs') {
    if (env.TAILOR_NEATLOGS_PROJECT_ID !== TAILOR_RUNTIME_PROJECT) fail('Set TAILOR_NEATLOGS_PROJECT_ID to the approved Tailor runtime project before enabling ingestion.');
    const probeTraceId = env.TAILOR_NEATLOGS_PROBE_TRACE_ID ?? '';
    if (!/^[0-9a-f]{32}$/.test(probeTraceId)) fail('TAILOR_NEATLOGS_PROBE_TRACE_ID must identify a previously approved Doctor trace; startup verifies its project before ingestion.');
    const endpoint = env.NEATLOGS_ENDPOINT?.trim() || HOSTED_INGEST_ORIGIN;
    try { if (new URL(endpoint).origin !== HOSTED_INGEST_ORIGIN) fail('NEATLOGS_ENDPOINT must use the verified hosted origin.'); } catch { fail('NEATLOGS_ENDPOINT is not a valid verified endpoint.'); }
    telemetryProject = { apiKey: env.NEATLOGS_API_KEY!, endpoint, projectId: TAILOR_RUNTIME_PROJECT, probeTraceId };
  }

  let spend: SpendGuard | undefined;
  let providerConfig: ProviderConfig = { kind: 'mock' };
  if (providerKind === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) fail('TAILOR_PROVIDER=anthropic needs ANTHROPIC_API_KEY. Put it in .env.local (gitignored) and start with `npm run dev:live`; never export it in chat or commit it.');
    const capRaw = env.TAILOR_LIVE_CAP_USD;
    const capUsd = Number(capRaw);
    if (!capRaw || !Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 50) {
      fail('TAILOR_LIVE_CAP_USD must be a number in (0, 50] (USD) that you have explicitly approved. Live calls refuse to start without it.');
    }
    const model = (env.TAILOR_MODEL ?? 'claude-sonnet-5-5').trim();
    const effort = (env.TAILOR_EFFORT ?? 'medium').trim() as Effort;
    if (!EFFORTS.includes(effort)) fail(`TAILOR_EFFORT must be one of ${EFFORTS.join(', ')} (got ${effort}).`);
    if (maxOutputTokensFor(effort) === null) fail(`TAILOR_EFFORT=${effort} needs more output tokens than this build allows per call. Use low, medium or high.`);
    if (!hasRatesFor(model)) fail(`TAILOR_MODEL=${model} has no configured token rates, so spend cannot be estimated against the cap. Use a model with known rates.`);
    try { spend = createSpendGuard({ capUsd, ledgerPath }); }
    catch (e) { fail(`Spend ledger at ${ledgerPath} could not be loaded (${(e as Error).message}). Live calls refuse to start.`); }
    providerConfig = { kind: 'anthropic', apiKey, model, effort, spend };
  }

  return {
    port, dataPath, ledgerPath, telemetryMode, devKey: env.TAILOR_DEV_KEY, providerConfig,
    ...(telemetryMode === 'neatlogs' ? { neatlogs: { apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT?.trim() || undefined } } : {}),
    ...(spend ? { spend } : {}),
    ...(telemetryProject ? { telemetryProject } : {}),
  };
}
