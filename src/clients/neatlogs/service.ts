// The ONE server-side Tailor product agent for the Neatlogs demo: the generic core bound to the Neatlogs adapter.

import type { AgentService } from './agent-contract.ts';
import { createTailorCore } from '../../tailor/core.ts';
import { neatlogsAdapter } from './adapter.ts';

export { AGENT_LIMITS } from '../../tailor/core.ts';

export function createAgentService(): AgentService {
  const core = createTailorCore(neatlogsAdapter);
  return { handleTurn: input => core.handleTurn(input) };
}
