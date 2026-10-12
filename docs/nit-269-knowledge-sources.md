# NIT-269 Neatlogs knowledge sources

Checked 11 October 2026. Claims in `scope: "official_product"` records are limited to successfully fetched first-party pages below. Repository sources support only `scope: "clone_only"` records.

| URL | Date | Supports | Fetch status |
| --- | --- | --- | --- |
| https://neatlogs.com/ | 2026-10-11 | Product positioning, integrations, incident/detection examples, and the existence of a homepage “Start free” section | Success |
| https://neatlogs.com/pricing | 2026-10-11 | Intended dedicated pricing and plan verification | Failed: `CRAWL_NOT_FOUND` |
| https://docs.neatlogs.com/docs | 2026-10-11 | Product overview and documented feature catalogue | Success |
| https://docs.neatlogs.com/docs/quickstart/introduction | 2026-10-11 | Trace/span concepts, supported languages/providers, and dashboard purpose | Success |
| https://docs.neatlogs.com/sdk/typescript | 2026-10-11 | TypeScript setup, explicit integrations, span/trace APIs, lifecycle, masking, and PII controls | Success |
| https://docs.neatlogs.com/docs/features/traces | 2026-10-11 | Trace list, span tree/detail, timeline, trace assistant, and voting | Success |
| https://docs.neatlogs.com/docs/features/detections | 2026-10-11 | Regex, condition, PII, and classifier detections and their list/detail presentation | Success |
| https://docs.neatlogs.com/docs/features/alerts | 2026-10-11 | Alert rule types, severity/cooldown, and Slack/email/in-app/webhook destinations | Success |
| https://docs.neatlogs.com/docs/features/evals | 2026-10-11 | Structured human/AI review, aggregation, and export | Success |
| https://docs.neatlogs.com/docs/features/session-replay | 2026-10-11 | Experimental replay status, one-trace/session limit, and player views | Success |
| https://docs.neatlogs.com/docs/features/analytics | 2026-10-11 | Aggregate cost, latency, errors, tools, detections, filters, and drill-down | Success |
| https://docs.neatlogs.com/docs/features/experiments | 2026-10-11 | Prompt versions/labels/rollback, playground, and coming-soon datasets | Success |
| https://docs.neatlogs.com/docs/features/integrations | 2026-10-11 | Slack and issue-tracker integrations, trace imports, webhooks, and project keys | Success |
| https://www.npmjs.com/package/neatlogs | 2026-10-11 | Published package README and SDK configuration surface | Success; displayed package version lagged the repository-pinned 1.1.28 |
| https://github.com/neatlogs/neatlogs-typescript#readme | 2026-10-11 | Official TypeScript SDK README, explicit wrappers, span/trace lifecycle, and prompt client | Success |

The fetched homepage contains span-volume marketing copy, but the dedicated pricing URL failed. Accordingly `pricing.json` remains `unknown`, no named plans are recorded, and every capability has unknown ordinary plan availability.

## Unverified or excluded

- Named plan catalogue, exact plan entitlements, billing terms, taxes, overage rules, and contractual availability.
- Whether homepage “Start free” language corresponds to a durable named free plan.
- Current Python SDK signatures and version compatibility; Python is mentioned only as a documented platform topic, not modeled as a detailed capability record.
- Account administration, billing mutation, project mutation, API-key rotation behavior, and authenticated permissions.
- Production reliability, service-level objectives, regional availability beyond the fetched SDK wording, and security/compliance attestations.
- Complete real-product UI parity, mobile behavior, and all search/filter operators.
- Real Tailor telemetry ingestion health in this checkout.

## Slice limits

This slice is deliberately small and retrieval-oriented. It contains 20 records, uses deterministic keyword scoring, and returns at most six records per turn. Clone demonstrations use synthetic per-session data and cannot prove that an official feature is enabled for a buyer's project. Explain-only records never authorize Tailor to mutate a real Neatlogs project, alert, prompt, integration, account, or subscription.

## 12 October 2026 capability/eval refresh

The following first-party pages were successfully fetched read-only on 2026-10-12: Evals, Human Evaluators, AI Evaluators, Operation availability, Authentication and scopes, Detections, Experiments and Session Replay.

- https://docs.neatlogs.com/docs/features/evals — existing/arriving trace sources, per-question human/AI assignments and structured aggregates/export.
- https://docs.neatlogs.com/docs/features/evals/human-evaluators — trace review queues, assigned questions and question/batch results.
- https://docs.neatlogs.com/docs/features/evals/ai-evaluators — LLM/agent judges, rubric/verdict schema and playground versus actual review.
- https://docs.neatlogs.com/api-reference/availability — published schemas differ from runtime availability; October 6 release checks list classifier workflows, detection suggestions/preview and analytics export as disabled behind `tier-c-compute`, and future evaluation collection has a final-cohort caveat. This does not establish buyer eval access or imply all analytics is disabled.
- https://docs.neatlogs.com/api-reference/authentication — ingest credentials do not authorize Public API reads; evaluation scopes, roles and entitlements are separate.
- https://docs.neatlogs.com/docs/features/detections — rules annotate captured spans without changing execution.
- https://docs.neatlogs.com/docs/features/experiments — labelled evaluation datasets remain coming soon.
- https://docs.neatlogs.com/docs/features/session-replay — experimental status and current one-trace/session limit.

The map contains 25 records at knowledge version 2026-10-12.1. Ordinary pricing/plan entitlements and this buyer's hosted runtime availability remain unknown. No authenticated calls, hosted evaluator runs or integration configuration were performed. The local Evals service is a separate synthetic demonstration with immutable snapshots, actual buyer inputs and explicitly simulated judge values.
