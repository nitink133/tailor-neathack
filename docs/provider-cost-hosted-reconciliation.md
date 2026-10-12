# First-suite cost reconciliation from hosted receipts

The approved readback recovers all **60 provider attempts across the original 29 turns**, with matching project, exact recorded input/output and untruncated native envelopes. This supplies the per-attempt evidence absent from the original local-only audit. The other 15 readback turns belong to later phases and are excluded here.

Summed usage and recomputed configured-rate costs agree with every per-turn delta and all three stage totals in the original ledger: **277,453 uncached input tokens, 23,880 output tokens and $0.793706 estimated cost**. The 765 reported thinking tokens are included in output. Billing remains authoritative.

| Stage | Calls | Input tokens p50 / p95 / max | Output tokens p50 / p95 / max | Provider latency ms p50 / p95 / max | Estimated cost |
| --- | ---: | --- | --- | --- | ---: |
| Guard | 29 | 1,628 / 1,696 / 1,698 | 25 / 27 / 27 | 1,727 / 2,006 / 2,241 | $0.102496 |
| Plan | 24 | 9,012 / 9,730 / 9,741 | 483 / 1,811 / 3,511 | 4,770 / 10,422 / 22,738 | $0.647204 |
| Explain | 7 | 1,642 / 1,836 / 1,836 | 280 / 353 / 353 | 3,307 / 4,228 / 4,228 | $0.044006 |

Percentiles use nearest rank (`ceil(p × N)`, one-based). These timings come from each provider attempt, so they are slightly smaller than the surrounding step timings in the first local report. Explanation calls have hosted `step=model`; `tailor.purpose=explain` distinguishes them from planning. Native LLM span summaries corroborate each attempt by span ID and are not counted a second time.

All 60 calls explicitly report `end_turn`, `settled_reported`, zero aggregate cache-read tokens and zero aggregate cache-write tokens. Guard effort is low; planning and explanation effort are medium. All reported model labels are `claude-sonnet-5-5`, originating from the configured/requested model. **The API-resolved model ID is still unavailable.** The API's complete usage object and separate 5m/1h cache-write counters were not retained. Cache zeros can now be stated as explicitly reported, rather than inferred from ledger defaults.

## Context and failure evidence

Recorded component bytes match the offline reconstruction on **all 60 requests**, and recorded context bytes/characters/budgets match on **all 24 planner contexts**. No mismatches were found. Full request byte p50/p95/max are guard 4,036/4,235/4,257; planner 19,813/21,431/21,844; explanation 3,425/3,761/3,761. These include system, conversation and schema bytes; provider-added framing remains an estimate. Per-component tokenizer counts and measured cache-prefix hashes remain unavailable.

All seven post-save explanation calls were rejected by the application as `ungrounded` after successful provider completion. They cost $0.044006 and accumulated 23.520 seconds of provider latency, then used code-generated fallback explanations. This proves application rejection and fallback, not that every rejected sentence was false. The three all-green-defect examples are among these seven; other fallback replies received good quality ratings. Evidence selection and admission therefore remain more immediate fixes than changing the explanation model.

The three falsely blocked contextual follow-ups now have directly observed guard decisions: `clarify / ambiguous`. The warehouse-correction turn was allowed by the guard, and its planner proposed a new scenario; the application returned clarification before saving. The next turn selected `explain` and described the still-saved version. These observations distinguish guard errors from post-planning behavior.

The most expensive individual attempt was the first retrieval-defect planner call: 8,961 input tokens, 3,511 output tokens (including 765 thinking), 22.738 seconds and $0.053032. Its whole turn cost $0.062310 and received a bad explanation-quality verdict. Longer context was not the distinguishing factor: its input count was below the planner median.

## Evidence and remaining boundaries

[The reconciliation JSON](provider-cost-hosted-reconciliation.json) includes the approved export's SHA-256, all 60 bounded numerical attempt records, distributions, guard decisions, fallback events and reconciliation coverage. It contains no raw prompts, replies, hidden reasoning or credentials. The [earlier audit](provider-cost-context-audit-first-pass.json) remains the original local-only snapshot; its unavailable token-percentile, latency, stop-reason and explicit-cache-zero fields are superseded by this report.

Reconciliation used an existing approved local export only. It made no account, ingestion or model calls and changed no provider implementation. These results describe one controlled synthetic baseline, not general model quality or production traffic.
