# Neatlogs knowledge slice

`neatlogs/capabilities.json` is a versioned array of the frozen `CapabilityRecord` contract. Records with `scope: "official_product"` paraphrase fetched first-party pages; records with `scope: "clone_only"` describe only the local Tailor proof of concept and cite repository evidence.

`neatlogs/pricing.json` keeps pricing verification separate from capability retrieval. Unknown means no suitable official pricing page was successfully verified; hackathon access is never treated as plan evidence.

## Versioning and sources

- Bump `neatlogs/version.json` whenever any capability record changes.
- Keep `recordCount` equal to the capabilities array length and `contractVersion` aligned with the frozen agent contract.
- Every source has a URL, ISO verification date, and a narrow paraphrased claim.
- Official-product sources must be fetched HTTP(S) pages. Clone-only sources may use `repo:` URLs.
- Do not turn estimates, observed hackathon access, or inferred entitlements into product facts.

## Loading and retrieval

`loadKnowledge()` (`src/clients/neatlogs/knowledge.ts`; the data stays in this directory) synchronously parses and validates the repository files. Its returned `KnowledgeIndex.select()` performs deterministic token scoring and returns no more than `LIMITS.maxKnowledgeRecordsPerTurn` records (six in this contract), even if a caller asks for more. An empty query returns the executable core first.

This is a small, auditable keyword index. It is **not a vector store**, makes no network requests, and has no cache outside the returned index object.

## Capability support map (2026-10-12.1)

Each record now separates `productLimitations`, local `cloneSupport` (executable, explain-only, not implemented, or refused), and `hostedAvailability` (unknown or documented gated). Product documentation, local implementation and authenticated runtime access are different evidence. `src/clients/neatlogs/capabilities.ts` projects a vetted public map and exactly three editable starter prompts without exposing private data. Local eval forms/manual reviews and explicitly simulated judge values do not prove hosted AI evaluator access.
