// Composition root for the Tailor local server. Owner: orchestrator.
// Wires the backend (store, routes, telemetry), the single server-side agent and the knowledge index.
// Reads plain environment variables only; it never loads .env.local itself and never prints secrets.
import { Store } from './store.ts';
import { appServer, startSweeper } from './server.ts';
import { createTelemetry, type TelemetryMode } from './telemetry.ts';
import { createAgentService } from './agent/service.ts';
import { createProvider } from './agent/provider.ts';
import { loadKnowledge } from './knowledge.ts';
import { systemClock } from './agent-contract.ts';

const env = process.env;
const port = Number(env.PORT ?? 4321);
const dataPath = env.TAILOR_DATA_PATH ?? '.local/tailor.sqlite';
const providerKind = env.TAILOR_PROVIDER ?? 'mock';
const telemetryMode = (env.TAILOR_TELEMETRY ?? 'captured') as TelemetryMode;

if (providerKind !== 'mock') {
  // Live providers are an approval gate (provider/model ID, data flow, API eligibility, spend cap).
  console.error(`TAILOR_PROVIDER=${providerKind} is not approved or configured. Only "mock" runs in this slice.`);
  process.exit(2);
}
if (!['disabled', 'captured', 'neatlogs'].includes(telemetryMode)) {
  console.error(`TAILOR_TELEMETRY must be disabled, captured or neatlogs (got ${telemetryMode}).`);
  process.exit(2);
}
if (telemetryMode === 'neatlogs' && !env.NEATLOGS_API_KEY) {
  console.error('TAILOR_TELEMETRY=neatlogs needs NEATLOGS_API_KEY in the environment (external ingestion is a separate approval).');
  process.exit(2);
}

const clock = systemClock;
const store = new Store(dataPath, { clock });
const telemetry = await createTelemetry({
  mode: telemetryMode,
  secret: store.secret,
  ...(telemetryMode === 'neatlogs' ? { apiKey: env.NEATLOGS_API_KEY, endpoint: env.NEATLOGS_ENDPOINT?.trim() || undefined } : {}),
});
const knowledge = loadKnowledge();
const provider = createProvider({ kind: 'mock' });
const agent = createAgentService();

const server = appServer(store, { devKey: env.TAILOR_DEV_KEY, agent, provider, knowledge, telemetry, clock });
const stopSweeper = startSweeper(store, clock);
server.listen(port, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  console.log(`Tailor local demo: http://127.0.0.1:${address.port} · provider=${provider.name} (${provider.mode}) · telemetry=${telemetry.mode} · knowledge=${knowledge.version}`);
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
