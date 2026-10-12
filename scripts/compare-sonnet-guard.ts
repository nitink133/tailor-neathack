// Opt-in paired control: replay archived Haiku guard requests unchanged with Sonnet low.
// No regeneration, planner, retry, app mutation, rate override or model-id rewriting.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider, ANTHROPIC_FIXED_PARTS, type MessagesClientLike } from '../src/clients/neatlogs/anthropic-provider.ts';
import { DEFAULT_MODEL, reportedUsage, toAnthropicMessages } from '../src/tailor/anthropic-transport.ts';
import { createSpendGuard, DEFAULT_RATES, type SpendGuard } from '../src/tailor/spend.ts';
import { isProviderError } from '../src/tailor/provider-error.ts';
import type { PolicyRequest } from '../src/tailor/policy.ts';
import { reservationInput, type ComparisonPlan } from './compare-cheap-models.ts';

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export interface ArchivedComparison { plan: ComparisonPlan; rows: { caseId: string; phase: string; effort: string; wireEvidence?: { systemSha256: string; messagesSha256: string; schemaSha256: string; actualWireEffort: string }; [key: string]: unknown }[] }
export function prepareSonnetGuard(archive: ArchivedComparison) {
  if (archive.plan.schema !== 'tailor-cheap-model-comparison-v1' || hash(archive.plan.cases.map(c => c.request)) !== archive.plan.requestsSha256) throw Error('Archived material inputs changed');
  const cases = structuredClone(archive.plan.cases.filter(c => c.phase === 'guard'));
  if (cases.length !== 16 || new Set(cases.map(c => c.id)).size !== 16) throw Error('Expected exactly 16 distinct archived guard cases');
  const schemaSha256 = hash(ANTHROPIC_FIXED_PARTS.guard.schema);
  for (const c of cases) {
    if (c.request.responseSchema !== 'entry_policy' || c.request.maxOutputTokens !== 1024) throw Error('Archived guard schema/ceiling changed');
    const mapped = toAnthropicMessages(c.request.messages);
    for (const effort of ['low', 'medium']) {
      const rows = archive.rows.filter(r => r.caseId === c.id && r.phase === 'guard' && r.effort === effort);
      const wire = rows[0]?.wireEvidence;
      if (rows.length !== 1 || !wire || wire.schemaSha256 !== schemaSha256 || wire.systemSha256 !== hash(mapped.system)
        || wire.messagesSha256 !== hash(mapped.messages) || wire.actualWireEffort !== effort) throw Error(`Cannot verify paired request ${c.id}/${effort}`);
    }
  }
  const maxReservationUsd = cases.map(reservationInput).reduce((n, c) => n + (c.inputTokens * DEFAULT_RATES.inputPerMTok + c.outputTokens * DEFAULT_RATES.outputPerMTok) / 1e6, 0);
  if (maxReservationUsd >= 0.50) throw Error('Paired guard reservation exceeds its $0.50 batch ceiling');
  return { schema: 'tailor-paired-sonnet-guard-v1' as const, model: DEFAULT_MODEL, effort: 'low' as const, calls: 16,
    archiveSha256: hash(archive), originalRequestsSha256: archive.plan.requestsSha256, cases, schemaSha256, maxReservationUsd,
    comparisonScope: 'Same archived system, messages, output schema and ceiling; only model and the previously recorded medium effort differ. This is guard dispatch accuracy/cost/latency evidence, not planner promotion.',
    haikuGuardRows: archive.rows.filter(r => r.phase === 'guard') };
}
export async function runSonnetGuard(archive: ArchivedComparison, options: { apiKey: string; client: MessagesClientLike; spend: SpendGuard; checkpoint?: (report: unknown) => void }) {
  const plan = prepareSonnetGuard(archive), initialSpend = options.spend.summary();
  if (initialSpend.capUsd !== 19 || initialSpend.pendingCalls !== 0) throw Error('Require the shared $19 ledger with zero pending calls and exclusive root writer');
  const actualReservation = plan.cases.map(reservationInput).reduce((n, c) => n + options.spend.worstCaseUsd(c.inputTokens, c.outputTokens, DEFAULT_MODEL), 0);
  if (Math.abs(actualReservation - plan.maxReservationUsd) > 1e-12) throw Error('Spend guard does not use the verified Sonnet model rates');
  options.spend.check(plan.maxReservationUsd);
  const rows: Record<string, unknown>[] = []; let stopReason: string | null = null, wireEvidence: Record<string, unknown> | null = null;
  const report = () => ({ plan, initialSpend, finalSpend: options.spend.summary(), rows, stopReason, defaultSwitch: false,
    guardEligibility: rows.some(r => r.status !== 'completed' || r.dispatchCorrect !== true) ? 'rejected' : rows.length === 16 ? 'eligible-for-review' : 'pending',
    executionRequirement: 'Root is sole ledger writer throughout; initial pending check is not a cross-process lock.' });
  const client: MessagesClientLike = { messages: { async create(params, opts) {
    // Forward params unchanged: rates and wire both identify Sonnet, native guard effort low.
    wireEvidence = { requestedModel: params.model, actualWireEffort: params.output_config.effort, requestSha256: hash(params),
      systemSha256: hash(params.system), messagesSha256: hash(params.messages), schemaSha256: hash(params.output_config.format.schema), maxOutputTokens: params.max_tokens,
      systemBytes: Buffer.byteLength(params.system), conversationBytes: params.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0), schemaBytes: Buffer.byteLength(JSON.stringify(params.output_config.format.schema)) };
    const raw = await options.client.messages.create(params, opts);
    wireEvidence.reportedUsage = reportedUsage(raw.usage);
    wireEvidence.apiResolvedModel = typeof raw.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(raw.model) ? raw.model : null;
    return raw;
  } } };
  const provider = createAnthropicProvider({ apiKey: options.apiKey, model: DEFAULT_MODEL, effort: 'low', spend: options.spend, client });
  for (const c of plan.cases) {
    wireEvidence = null;
    try {
      const response = await provider.classifyPolicy!(c.request as PolicyRequest);
      rows.push({ caseId: c.id, status: 'completed', response, wireEvidence, dispatchCorrect: c.expectedOutcomes!.includes(response.decision.outcome) });
    } catch (error) {
      stopReason = isProviderError(error) ? error.kind : 'unknown';
      rows.push({ caseId: c.id, status: 'failed', errorKind: stopReason, wireEvidence,
        ...(isProviderError(error) ? { usage: error.usage, costUsd: error.costUsd, reservationUsd: error.reservationUsd, settlement: error.settlement } : {}) });
    }
    if (options.spend.summary().unreconciledCalls > initialSpend.unreconciledCalls) stopReason = 'unreconciled_usage';
    options.checkpoint?.(report());
    if (stopReason) break;
  }
  return report();
}
async function main() {
  const args = process.argv.slice(2), execute = args.includes('--execute');
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const input = value('--haiku-report'), output = value('--report'), ledger = value('--ledger');
  if (!input || !output || args.some(a => a.startsWith('--') && !['--haiku-report', '--report', '--ledger', '--execute'].includes(a))) throw Error('Usage: node scripts/compare-sonnet-guard.ts --haiku-report prior-results.json --report output.json [--execute --ledger existing-shared-ledger.json]');
  if (resolve(input) === resolve(output) || (ledger && [input, output].some(p => resolve(p) === resolve(ledger)))) throw Error('Inputs, output and ledger must be distinct');
  if (statSync(input).size > 10_000_000) throw Error('Archived report exceeds input bound');
  const archive: ArchivedComparison = JSON.parse(readFileSync(input, 'utf8'));
  const plan = prepareSonnetGuard(archive);
  const save = (report: unknown) => writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (!execute) { save(plan); console.log(JSON.stringify({ mode: 'prepared-only', calls: plan.calls, maxReservationUsd: plan.maxReservationUsd, originalRequestsSha256: plan.originalRequestsSha256 })); return; }
  if (!ledger || !statSync(ledger).isFile()) throw Error('Existing shared ledger is required');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Error('The authorized executor must supply its existing API-key environment');
  const spend = createSpendGuard({ capUsd: 19, ledgerPath: ledger });
  const client = new Anthropic({ apiKey, maxRetries: 0 }) as unknown as MessagesClientLike;
  save(await runSonnetGuard(archive, { apiKey, client, spend, checkpoint: save }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
