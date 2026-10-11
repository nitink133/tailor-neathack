import type { Scenario } from './contracts.ts';

export const ADAPTER_LABEL = 'Deterministic prototype adapter';

export interface AdapterInput {
  text: string;
  hasSession: boolean;
  activeScenario: Scenario | null;
}

export interface AdapterResult {
  action: 'ask' | 'create' | 'switch' | 'explain' | 'unchanged';
  scenario: Scenario | null;
  description: string;
  text: string;
}

const RECOVERED = /retry|recover|first attempt/i;
const EXHAUSTED = /both attempts|escalat|exhausted/i;
const EXPLAIN = /explain|why|what happened|this trace|open trace/i;

export function adapt(input: AdapterInput): AdapterResult {
  const text = input.text.trim();
  const recovered = RECOVERED.test(text);
  const exhausted = EXHAUSTED.test(text);
  const explain = EXPLAIN.test(text);
  const blank = { action: 'ask' as const, scenario: null, description: text, text: `${ADAPTER_LABEL}. Say which fictional failure to open: a retry that recovers, or both attempts failing.` };
  if (!text) return blank;
  if (explain && input.hasSession && !recovered && !exhausted) {
    const active = input.activeScenario ?? 'unset';
    return { action: 'explain', scenario: null, description: text, text: `${ADAPTER_LABEL}. The open synthetic fixture is ${active}. Both traces stay in this session. No model read them.` };
  }
  if (recovered === exhausted) {
    return { action: 'ask', scenario: null, description: text, text: recovered
      ? `${ADAPTER_LABEL}. That mentions both fixtures. Choose one: retry recovers, or both attempts fail.`
      : input.hasSession
        ? `${ADAPTER_LABEL}. I can switch the synthetic fixture or explain the open trace. The saved scenario was not changed.`
        : `${ADAPTER_LABEL}. This demo only opens two synthetic fixtures. Should the first lookup fail and the retry recover, or should both attempts fail?` };
  }
  const scenario: Scenario = exhausted ? 'exhausted' : 'recovered';
  const label = scenario === 'recovered' ? 'retry recovers' : 'both attempts fail';
  if (!input.hasSession) return { action: 'create', scenario, description: text.slice(0, 4000), text: `${ADAPTER_LABEL}. I will open the synthetic “${label}” fixture only after the demo API saves it.` };
  if (input.activeScenario === scenario) return { action: 'unchanged', scenario, description: text, text: `${ADAPTER_LABEL}. That fixture is already saved. Nothing was changed.` };
  return { action: 'switch', scenario, description: text, text: `${ADAPTER_LABEL}. The previous fixture stays until the demo API saves “${label}”.` };
}
