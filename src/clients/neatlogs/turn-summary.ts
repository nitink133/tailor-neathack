import type { TurnOutcome, TurnStep } from './agent-contract.ts';

/** Describe the latest result, rather than treating every completed pipeline step as success. */
export function turnSummary(steps: TurnStep[], outcome?: TurnOutcome): string {
  const status = (name: TurnStep['name']) => steps.findLast(step => step.name === name)?.status;
  switch (outcome) {
    case 'committed':
      if (status('save') === 'ok' && status('readback') === 'ok') return 'Saved your synthetic demo and confirmed the saved trace.';
      if (status('save') === 'ok') return 'Your demo was saved, but I couldn’t confirm the saved trace.';
      return '';
    case 'readback_uncertain':
      return 'Your demo may have been saved, but I couldn’t verify the saved trace.';
    case 'save_failed':
      return 'I couldn’t save your changes, so your demo is unchanged.';
    case 'rejected':
      return 'Your request didn’t pass the demo’s checks, so nothing was changed.';
    case 'refused':
      return 'I declined that request. Nothing was changed.';
    case 'unsupported':
      return 'That action isn’t available in this demo. Nothing was changed.';
    case 'conflict':
      return 'The demo changed before I could save your request. Your changes weren’t applied.';
    case 'expired':
      return 'This demo has ended or expired. Start a new demo to continue.';
    case 'provider_unavailable':
      return 'I couldn’t finish this request. Nothing was changed.';
    case 'clarification':
      return 'Choose an option or describe what you want next. No demo changes have been made.';
    case 'answered':
      if (status('explain') === 'failed') return 'I couldn’t read the saved trace. Nothing was changed.';
      // An OK explain step can also be a completed lookup that returned no trace.
      // Describe the lookup, without claiming that a trace was found or explained.
      if (status('explain') === 'ok' && status('load_context') === 'ok') return 'I checked for the saved trace to help explain your request. Nothing was changed.';
      if (status('retrieve_knowledge') === 'ok') return 'I checked the product knowledge for your question. Nothing was changed.';
      return '';
    default:
      // A partial log or unknown outcome does not establish a completed result.
      return '';
  }
}
