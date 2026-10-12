// Network-free apart from an ephemeral loopback server. Never loads .env.local or calls a paid provider.
import { writeFileSync } from 'node:fs';
import { runQualityEvaluations } from '../src/evaluation/quality-runner.ts';
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--report')) throw new Error('Usage: npm run eval:quality -- [--report /path/report.json]');
const report = await runQualityEvaluations();
if (args[1]) writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ suite: report.suite, passed: report.passed, policyCases: report.policy.cases.length, falseBlocks: report.policy.falseBlocks,
  offTopicEscapes: report.policy.offTopicEscapes, runtimeCases: report.runtime.length, runtimeFailures: report.runtime.filter(c => !c.passed).map(c => ({ id: c.id, failedChecks: c.checks.filter(x => !x.passed).map(x => x.name) })),
  policyFailures: report.policy.cases.filter(c => !c.passed), liveClassifierAccuracy: report.provider.liveAccuracy, tokenUsage: null, knownCostUsd: 0,
}, null, 2));
process.exitCode = report.passed ? 0 : 1;
