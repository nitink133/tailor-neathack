// The core claim rules bound to the Neatlogs product name. Grounding, answers and tests import the named functions here.
import { createClaimRules } from '../../tailor/claims.ts';

export {
  splitSentences, hasPricingClaim, hasBlanketPlanClaim, hasLimitNumber, isDemoScoped, stem, PLAN_WORDS,
  buildCorpus, shadowOf, numberWordsToDigits, hasForeignNumeral, hasUngroundableNumber, numbersGroundedIn, type Corpus,
} from '../../tailor/claims.ts';

export const PRODUCT_NAMES = ['neatlogs'] as const;

export const {
  hasPlanClaim, hasCapabilityAssertion, hasCapabilityClaim, isUngroundedClaim, stripUngroundedClaims, sanitiseClarificationText, allWordsGroundedIn,
} = createClaimRules(PRODUCT_NAMES);
