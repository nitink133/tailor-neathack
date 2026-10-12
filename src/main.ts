// Composition root for the Tailor local server. Owner: orchestrator.
// Wires the infrastructure (store, routes, telemetry), the Tailor core bound to the Neatlogs demo adapter, and the
// knowledge index. Reads plain environment variables only (src/infrastructure/config.ts); it never loads .env.local
// itself and never prints secrets. Local dev:live passes .env.local via Node's --env-file-if-exists;
// public production receives variables from the deployment operator.
import { createWebsiteServer } from '../marketing/server.mjs';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './infrastructure/store.ts';
import { appServer, startSweeper } from './infrastructure/server.ts';
import { createTelemetry } from './infrastructure/telemetry.ts';
import { readConfig } from './infrastructure/config.ts';
import { verifyRuntimeProject } from './infrastructure/telemetry-project.ts';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as adapterModule from './clients/neatlogs/adapter.ts';
import { CONTRACT_VERSION } from './clients/neatlogs/agent-contract.ts';
import { POLICY_VERSION } from './tailor/policy.ts';
import { createAgentService } from './clients/neatlogs/service.ts';
import { createProvider } from './clients/neatlogs/provider.ts';
import { loadKnowledge } from './clients/neatlogs/knowledge.ts';
import { PROMPT_VERSION } from './clients/neatlogs/prompts.ts';
import { systemClock } from './tailor/contract.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const publicOrigin = process.env.TAILOR_PUBLIC_ORIGIN?.trim();
if (publicOrigin) {
  try { const origin = new URL(publicOrigin); if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) fail('TAILOR_PUBLIC_ORIGIN must be an exact HTTPS origin without a trailing slash.'); } catch { fail('TAILOR_PUBLIC_ORIGIN must be an exact HTTPS origin.'); }
  if (![process.env.TAILOR_DATA_PATH, process.env.TAILOR_SPEND_LEDGER].every(path => path && isAbsolute(path))) fail('Public deployment requires absolute persistent database and ledger paths.');
  if (process.env.TAILOR_PROVIDER === 'anthropic' && Number(process.env.TAILOR_LIVE_CAP_USD) > 19) fail('Public deployment cannot increase the approved cumulative $19 runtime ceiling.');
}
if (process.env.NODE_ENV === 'production' && !publicOrigin) fail('Production requires TAILOR_PUBLIC_ORIGIN (an exact HTTPS origin).');
if (publicOrigin && process.env.TAILOR_SYNTHETIC_REVIEW_IDS?.trim()) fail('Public deployment cannot enable synthetic payload capture.');
if (publicOrigin && process.env.TAILOR_PROVIDER === 'anthropic' && !existsSync(process.env.TAILOR_SPEND_LEDGER!)) fail('Public live startup requires the existing cumulative spend ledger. Refusing a new budget.');
const config = readConfig(process.env, fail);
const { spend, ledgerPath } = config;
if (config.telemetryProject) {
  try { await verifyRuntimeProject(config.telemetryProject); } catch { fail('The telemetry key project could not be verified. No exporter was initialized.'); }
}
let codeVersion = /^[a-f0-9]{40}$/.test(process.env.RAILWAY_GIT_COMMIT_SHA ?? '') ? process.env.RAILWAY_GIT_COMMIT_SHA! : 'code-version-unavailable';
try { codeVersion = execFileSync('git', ['-C', fileURLToPath(new URL('../', import.meta.url)), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* explicit unknown, never a fabricated revision */ }
const adapterVersion = typeof (adapterModule as unknown as Record<string, unknown>).NEATLOGS_ADAPTER_VERSION === 'string'
  ? (adapterModule as unknown as Record<string, string>).NEATLOGS_ADAPTER_VERSION : 'adapter-version-unavailable';

const clock = systemClock;
const store = new Store(config.dataPath, { clock });
// Operator-only allowlist for this approved synthetic review. Buyer descriptions
// cannot opt in; every other session retains payload-free telemetry.
const syntheticReviewIds = new Set((process.env.TAILOR_SYNTHETIC_REVIEW_IDS ?? '').split(',').filter(id => /^[0-9a-f-]{36}$/.test(id)));
const telemetry = await createTelemetry({
  mode: config.telemetryMode,
  secret: store.secret,
  syntheticPayloads: syntheticReviewIds.size > 0,
  versions: { codeVersion, adapterVersion, contractVersion: CONTRACT_VERSION, contextSchemaVersion: 1, policyVersion: POLICY_VERSION },
  ...(config.neatlogs ?? {}),
});
const knowledge = loadKnowledge();
const provider = createProvider(config.providerConfig);
const agent = createAgentService();

const server = appServer(store, { devKey: config.devKey, agent, provider, knowledge, telemetry, clock, syntheticFixture: id => syntheticReviewIds.has(id), ...(spend ? { spend } : {}) });
const stopSweeper = startSweeper(store, clock);
let website: ReturnType<typeof createWebsiteServer> | undefined;
server.listen(publicOrigin ? 0 : config.port, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  if (publicOrigin) {
    website = createWebsiteServer({ demoOrigin: `http://127.0.0.1:${address.port}`, publicOrigin });
    website.listen(config.port, '0.0.0.0', () => console.log(`Tailor public listener ready on PORT=${(website!.address() as {port: number}).port}`));
  }
  const live = spend ? ` · effort=${provider.effort ?? 'n/a'} · cap=$${(spend.summary() as { capUsd: number }).capUsd} (estimates; billing is authoritative) · spend ledger=${ledgerPath}` : '';
  console.log(`Tailor local demo: http://127.0.0.1:${address.port} · build=${codeVersion} · provider=${provider.name} (${provider.mode}) · model=${provider.model ?? 'none'}${live} · telemetry=${telemetry.mode} · knowledge=${knowledge.version} · prompts=${PROMPT_VERSION}`);
});

let closing = false;
async function close() {
  if (closing) return; closing = true;
  stopSweeper();
  if (website) await new Promise<void>(resolve => website!.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  try { await telemetry.shutdown(); } catch { /* exporter failures never block shutdown */ }
  store.close();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void close());
