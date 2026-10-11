// Composition root for the Tailor local server. Owner: orchestrator.
// Wires the backend (store, routes, telemetry), the single server-side agent and the knowledge index.
// Reads plain environment variables only; it never loads .env.local itself and never prints secrets.
// Live mode is entered only through `npm run dev:live`, which passes .env.local via Node's --env-file-if-exists.
import { Store } from './store.ts';
import { appServer, startSweeper } from './server.ts';
import { createTelemetry, type TelemetryMode } from './telemetry.ts';
import { createAgentService } from './agent/service.ts';
import { createProvider, type ProviderConfig } from './agent/provider.ts';
import { createSpendGuard, type SpendGuard } from './agent/spend.ts';
import { loadKnowledge } from './knowledge.ts';
import { systemClock } from './agent-contract.ts';
import { dirname } from 'node:path';

const env = process.env;
const port = Number(env.PORT ?? 4321);
const dataPath = env.TAILOR_DATA_PATH ?? '.local/tailor.sqlite';
const providerKind = env.TAILOR_PROVIDER ?? 'mock';
const telemetryMode = (env.TAILOR_TELEMETRY ?? 'captured') as TelemetryMode;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (providerKind !== 'mock' && providerKind !== 'anthropic') {
  fail(`TAILOR_PROVIDER=${providerKind} is not supported. Use "mock" (default, offline) or "anthropic" (approved live baseline).`);
}
if (!['disabled', 'captured', 'neatlogs'].includes(telemetryMode)) {
  fail(`TAILOR_TELEMETRY must be disabled, captured or neatlogs (got ${telemetryMode}).`);
}
if (telemetryMode === 'neatlogs' && !env.NEATLOGS_API_KEY) {
  fail('TAILOR_TELEMETRY=neatlogs needs NEATLOGS_API_KEY in the environment (external ingestion is a separate approval).');
}

// Live provider gates. Every one of these is checked BEFORE any network client exists.
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
  spend = createSpendGuard({ capUsd, ledgerPath: `${dirname(dataPath)}/spend-ledger.json` });
  providerConfig = { kind: 'anthropic', apiKey, model, effort, spend };
}

const clock = systemClock;
const store = new Store(dataPath, { clock });
const telemetry = await createTelemetry({
  mode: telemetryMode,
  secret: store.secret,
  ...(telemetryMode === 'neatlogs' ? { apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT?.trim() || undefined } : {}),
});
const knowledge = loadKnowledge();
const provider = createProvider(providerConfig);
const agent = createAgentService();

const server = appServer(store, { devKey: env.TAILOR_DEV_KEY, agent, provider, knowledge, telemetry, clock, ...(spend ? { spend } : {}) });
const stopSweeper = startSweeper(store, clock);
server.listen(port, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  const live = spend ? ` · effort=${provider.effort ?? 'n/a'} · cap=$${(spend.summary() as { capUsd: number }).capUsd} (estimates; billing is authoritative)` : '';
  console.log(`Tailor local demo: http://127.0.0.1:${address.port} · provider=${provider.name} (${provider.mode}) · model=${provider.model ?? 'none'}${live} · telemetry=${telemetry.mode} · knowledge=${knowledge.version}`);
});

let closing = false;
async function close() {
  if (closing) return; closing = true;
  stopSweeper();
  await new Promise<void>(resolve => server.close(() => resolve()));
  try { await telemetry.shutdown(); } catch { /* exporter failures never block shutdown */ }
  store.close();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void close());
