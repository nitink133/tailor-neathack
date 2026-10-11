// Composition root for the Tailor local server. Owner: orchestrator.
// Wires the infrastructure (store, routes, telemetry), the Tailor core bound to the Neatlogs demo adapter, and the
// knowledge index. Reads plain environment variables only (src/infrastructure/config.ts); it never loads .env.local
// itself and never prints secrets. Live mode is entered only through `npm run dev:live`, which passes .env.local via
// Node's --env-file-if-exists.
import { Store } from './infrastructure/store.ts';
import { appServer, startSweeper } from './infrastructure/server.ts';
import { createTelemetry } from './infrastructure/telemetry.ts';
import { readConfig } from './infrastructure/config.ts';
import { createAgentService } from './clients/neatlogs/service.ts';
import { createProvider } from './clients/neatlogs/provider.ts';
import { loadKnowledge } from './clients/neatlogs/knowledge.ts';
import { systemClock } from './tailor/contract.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const config = readConfig(process.env, fail);
const { spend, ledgerPath } = config;

const clock = systemClock;
const store = new Store(config.dataPath, { clock });
const telemetry = await createTelemetry({
  mode: config.telemetryMode,
  secret: store.secret,
  ...(config.neatlogs ?? {}),
});
const knowledge = loadKnowledge();
const provider = createProvider(config.providerConfig);
const agent = createAgentService();

const server = appServer(store, { devKey: config.devKey, agent, provider, knowledge, telemetry, clock, ...(spend ? { spend } : {}) });
const stopSweeper = startSweeper(store, clock);
server.listen(config.port, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  const live = spend ? ` · effort=${provider.effort ?? 'n/a'} · cap=$${(spend.summary() as { capUsd: number }).capUsd} (estimates; billing is authoritative) · spend ledger=${ledgerPath}` : '';
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
