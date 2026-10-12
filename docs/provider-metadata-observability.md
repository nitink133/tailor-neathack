# Provider metadata for cost and model comparisons

The first controlled live suite recorded 29 turns and 60 provider calls. Its estimated cost rose from $1.619646 to $2.413352, a $0.793706 delta. Planning accounted for $0.647204 (81.54%). The configured model was `claude-sonnet-5-5`, with medium effort for planning/explanation and low effort for entry classification. That suite did not retain API-resolved model IDs or individual usage receipts locally. These are configured-rate estimates, not billing totals.

The accompanying [first-pass audit](provider-cost-context-audit-first-pass.json) preserves aggregate usage, per-turn costs, quality groups, and offline reconstructed request sizes for baseline commit `ea7d0f028c3570a6ee834138c33717bdddf39bc9`. Its byte counts are reconstructed from the approved synthetic records and baseline source, not API tokenizer counts or captured wire requests. Historical gaps remain unavailable; this change does not backfill them.

A subsequent [approved hosted reconciliation](provider-cost-hosted-reconciliation.md) recovers the existing per-attempt token counters, latency, stop reasons and explicit aggregate cache zeros for all 60 baseline calls, and validates all reconstructed request sizes. API-resolved IDs and raw cache-TTL usage remain unavailable historically. The instrumentation below adds those missing fields for future calls.

## New evidence

Every dispatched Anthropic call carries a bounded `providerMetadata` object through successful planning, explanation and guard responses, and through provider errors after dispatch:

- `requestedModel` records the requested alias. `resolvedModel` records the API response ID only when it matches bounded Claude model-ID syntax. An absent or invalid response ID stays absent; the requested alias is never substituted. Syntax validation does not establish account availability, pricing or model quality.
- `reportedUsage` retains only validated integer counters under their original provider field names: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, nested `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, and `output_tokens_details.thinking_tokens` when valid. Optional missing/null/malformed fields are omitted; explicit zero is preserved. Unknown fields and response content are never copied.
- `outputTokensIncludeThinking: true` makes the Anthropic accounting convention explicit. Thinking is a subset of output, not an additional charge. The diagnostic copy does not participate in settlement; the existing usage validation, conservative cache-write pricing and reservations are unchanged.
- Existing stop reason, request ID, latency, cost and settlement metadata continue alongside these fields, including billed truncation/refusal errors. A timeout without a response has only requested-model and input-component metadata, without an invented resolved ID, usage or stop reason.
- Input accounting includes mapped conversation message count, exact system/conversation/schema UTF-8 byte counts, existing conservative token estimates, and SHA-256 fingerprints for mapped system text and serialized schema. No buyer/history/message text or hashes are added. `systemPrefixSha256` identifies the system component only; it is not an API cache-boundary hash, proof of a cache hit, or a provider token count.

Core attempt telemetry projects these into allowlisted scalar attributes. `tailor.requested_model` and `tailor.resolved_model` remain distinct from the existing requested-model field used for cost attribution. `tailor.reported_*_tokens` preserve usage availability and TTL detail; there is no raw JSON usage or response dump. Native diagnostic summaries expose at most four observed `providerAttempts` within the existing 24,000-character envelope. Existing envelope truncation flags and per-span metadata still apply; a native summary is not proof of complete delivery.

Both attribute admission and the export mask validate model IDs, integer counters and exact 64-hex fingerprints. These fingerprints receive a narrow exemption from generic high-entropy string rejection; arbitrary hash-shaped fields remain denied. The existing explicit synthetic-payload gate remains the only route for original buyer/reply text in native panels.

## Verification and boundaries

Offline tests use injected responses and captured telemetry. They cover requested/resolved identity, counters with missing/zero/invalid values, TTL splits, inclusive output, unchanged settlement, stable system hashes across different buyer messages, success/error/timeout paths, all provider codecs, core guard/planner propagation, native summaries, and privacy rejection. Fixture model IDs are synthetic test values, not an availability claim.

This change makes no live, account or paid calls, enables no caching, changes no models or routing, and changes no pricing/financial guards. A later authorized live comparison must collect actual receipts before claiming savings, model availability or better quality. Usage reported before this instrumentation cannot acquire new precision retrospectively.

Entire 0.11.4 was enabled in the isolated checkout, but the current caller had no Entire session state during the audit/task-start checks. Live capture was unverified; no hooks, trust, authentication or historical linkage were changed.
