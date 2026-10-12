// Material changes are decided from saved and normalized proposed state, never from the model's mode alone.
import type { Dataset, DemoSession, Trace } from './contracts.ts';
import type { ScenarioProposal } from './agent-contract.ts';

const words = (text: string) => text.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim();
const domainWords = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'agent', 'agents', 'assistant', 'bot', 'workflow', 'pipeline', 'copilot', 'fictional', 'synthetic', 'demo', 'project']);
const rootWords = new Set([...domainWords, 'retry', 'retries', 'timeout', 'failure', 'failed', 'fail', 'fails', 'success', 'successful', 'recovered', 'recovery', 'scenario', 'variant']);
function category(text: string): string | null {
  const t = words(text);
  if (/\b(?:invoice|extraction|extractor)\b/.test(t)) return 'extraction';
  if (/\b(?:insurance|claims?)\b/.test(t)) return 'insurance';
  if (/\b(?:travel|booking|flight|itinerary)\b/.test(t)) return 'travel';
  if (/\b(?:documentation|retrieval|retriever|rag|question answering|knowledge)\b/.test(t)) return 'retrieval';
  if (/\b(?:support|customer|order)\b/.test(t)) return 'support';
  if (/\b(?:calendar|scheduling|schedule|appointment)\b/.test(t)) return 'scheduling';
  return null;
}
function identity(text: string): string {
  return category(text) ?? [...new Set(words(text).split(' ').filter(w => w && !domainWords.has(w)))].sort().join(' ');
}
function rootName(trace: Trace): string { return trace.spans.find(s => s.parentId === null)?.name ?? trace.name; }
function rootTokens(trace: Trace): Set<string> { return new Set(words(rootName(trace)).split(' ').filter(w => w && !rootWords.has(w))); }
function rootShape(trace: Trace): Set<string> {
  const root = trace.spans.find(s => s.parentId === null);
  const keys = new Set<string>();
  const generic = new Set(['synthetic', 'status', 'success', 'ok', 'data', 'payload', 'value', 'text', 'message', 'result']);
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) { if (!generic.has(key.toLowerCase())) keys.add(key.toLowerCase()); visit(child); }
  };
  visit(root?.input); visit(root?.output); return keys;
}
export type MaterialSwitchReason = 'replace_dataset' | 'workflow_changed' | 'replace_all_records';
export function materialSwitchReason(current: DemoSession, proposal: ScenarioProposal, normalized: Dataset): MaterialSwitchReason | null {
  if (current.version === 1) return null;
  if (proposal.mode === 'new') return 'replace_dataset';
  const oldIdentity = current.story ? identity(current.story.domain) : null;
  const nextIdentity = identity(proposal.story.domain);
  if (oldIdentity && nextIdentity && oldIdentity !== nextIdentity) return 'workflow_changed';
  const oldKeys = new Set(current.dataset.traces.map(t => t.scenario));
  if (oldKeys.size && normalized.traces.every(t => !oldKeys.has(t.scenario))) return 'replace_all_records';
  const active = normalized.traces.find(t => t.scenario === normalized.activeScenario);
  const savedActive = current.dataset.traces.find(t => t.scenario === current.dataset.activeScenario);
  const beforeCategory = current.story ? category(current.story.domain) : savedActive ? category(rootName(savedActive)) : null;
  const afterCategory = active ? category(rootName(active)) : null;
  if (beforeCategory && afterCategory && beforeCategory !== afterCategory) return 'workflow_changed';
  // Reusing old keys does not make replacing every workflow a small edit. Compare normalized saved roots as well.
  if (normalized.traces.length && normalized.traces.every(next => {
    const previous = current.dataset.traces.find(t => t.scenario === next.scenario);
    if (!previous) return true;
    const before = rootTokens(previous); const after = rootTokens(next);
    const beforeShape = rootShape(previous); const afterShape = rootShape(next);
    const changedName = before.size > 0 && after.size > 0 && ![...before].some(token => after.has(token));
    const changedShape = beforeShape.size > 0 && afterShape.size > 0 && ![...beforeShape].some(key => afterShape.has(key));
    return changedName || changedShape;
  })) return 'replace_all_records';
  return null;
}
