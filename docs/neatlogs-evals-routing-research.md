# Neatlogs evals and routing evidence

Observed 2026-10-12, read-only, authenticated Tailor project in a separate Chrome research tab. Base: `db855671fc4f3fe8e5bddfb7616f64fcc67714a9`. No product objects were created, existing settings changed, integrations connected, alerts delivered, or model calls made. The eval builder was opened then left without edits. An alert wizard was inspected through Response using transient unsaved values, then discarded. The current Tailor demo on port 4328 was not visited or changed.

## Verified product and native screens

[Evals documentation](https://docs.neatlogs.com/docs/features/evals) describes structured questions over captured traces/spans or an arriving collection window. Assignment is per question, to humans, configured AI judges, or both. Results aggregate and export. [Human evaluators](https://docs.neatlogs.com/docs/features/evals/human-evaluators) work through assigned questions with deadlines and batch views. [AI evaluators](https://docs.neatlogs.com/docs/features/evals/ai-evaluators) use rubric/verdict schemas, single-pass LLM or tool-using agent judges. Playground trials do not count as reviews.

Authenticated [Evals](https://app.neatlogs.com/evals) offered Batches, Schedules, Drafts and Assigned to me, status filters and a table with Status, Eval, Progress, Schedule, Eval window, Evaluators, Created by and Eval type. The empty introduction describes shared AI/human judgment. New eval is a full-page four-part setup: Dataset, Evaluators, Form, Review. Dataset has Type, Schedule and Conditions. Trace-level means first message input and final answer output, one trace per row; Span-level means the selected step's own input and output. Later setup stages and dispatch were not exercised.

[Product eval guidance](https://neatlogs.com/product/evals) frames the question as whether behavior met an explicit standard; test the judge, compare human/AI agreement and recalibrate disagreements. Adapter recommendation: ask the buyer what a good answer/action looks like, choose a trace or span accordingly, define observable pass criteria, and test successful, failing and ambiguous examples. For example, a retrieval agent can check source-backed claims; extraction can check required fields; a workflow can check tools, recovery and approval boundaries. A small passing sample is no production-quality guarantee. Ambiguous correctness, tone and policy exceptions still need expert judgment. This is guidance, not a claim that local samples measure AI calibration.

[Homepage pricing](https://neatlogs.com/#pricing) explicitly lists human evals on Free, an AI-evaluation allowance on Starter and unlimited evaluations on Pro. These are published plan descriptions, not verification of the buyer's entitlement. Do not infer runtime access from ingestion credentials or visible UI.

## Routing means alert delivery, reviewer assignment, or personal updates

Authenticated [Alerts](https://app.neatlogs.com/alerts) introduces routing critical signals to people via Slack/email with useful context. The unsaved New alert dialog uses Type → Condition → Details → Response → Confirm. Type offers Threshold, Per event, Metric threshold, Compound, Ingestion health. Threshold Condition selects a detection, count, window minutes, cooldown and optional filters; Details asks for name and Critical/Warning/Info severity.

Response asks how the alert should be delivered. Native observed rows were:

- In-app: always on.
- Email: depends on notification preferences; a link leads to Notifications settings.
- Slack: disconnected in this account, with a disabled rule toggle and connection link.
- Webhooks: none configured in this account, with a configuration link.

[Alerts documentation](https://docs.neatlogs.com/docs/features/alerts) confirms those rule types, severity, time windows, cooldowns and destinations. [Integrations documentation](https://docs.neatlogs.com/docs/features/integrations) distinguishes app connections from per-teammate Tools & MCPs. No evidence supports inventing an on-call roster, arbitrary contact picker or automatic teammate ownership. [Collaboration](https://neatlogs.com/product/collaboration) describes evidence-linked comments and issue/coding-agent handoffs, which are distinct from alert rules.

Authenticated [Notifications settings](https://app.neatlogs.com/settings/account/notifications) has personal Slack DM and account-email preferences for incident/critical/non-critical alerts, comments/mentions, approvals, prompt/experiment changes, daily digest and evaluation assignments/updates. It separately exposes digest time/timezone, quiet hours and project daily digest. Quiet hours hold non-critical deliveries while critical alerts can still arrive. No preferences were saved.

The exact named action “Update me” was not verified in the inspected docs, Alerts, Notifications or existing incident detail. The Incidents list does have Attention, Watching and All tabs; no watcher mutation was attempted and its subscription semantics were not established. Treat update-me buyer wording as ambiguous: clarify monitored alert versus personal update category/digest versus assigned evaluation. Do not silently create a future watch or invent notification dispatch.

## Adapter and demo boundaries

Keep knowledge and guidance in the Neatlogs adapter. A local routing preview can demonstrate the native wizard and persist a session rule, matched synthetic evidence and a hypothetical destination. It must visibly say simulated/local; it sends nothing and proves no hosted access. Native wizard targets for contextual guidance: rule type, condition, severity, response/destination and final preview. Per-question evaluator assignment is a separate eval journey.

The implemented adapter executes fixed `no_error`, `latency` and `required_output_fields` checks against immutable trace snapshots. Each result records passed/failed/unavailable, observations and evidence IDs with `deterministic_check` / `local_trace_snapshot` provenance. Buyer review is manual; illustrative judge outcomes retain simulated provenance. None is a hosted AI review. Routing likewise executes a saved-snapshot match predicate, then stores a simulated destination preview. Cooldown is configuration only, not an active timer; fictional role choices are local demo design, not verified hosted owner assignment. Dataset changes flag saved evals and previews stale. Clear refresh/readback and session boundaries matter because saved configuration is different from delivery.

## Continuity and capture limit

Read the repository's `.agents/skills/entire-continuity/SKILL.md` in this worktree. Worktree `/private/tmp/tailor-evals-routing`, shared Git directory `/Users/nitinkhanna/Desktop/tailor-neathack/.git`, branch `codex/neatlogs-evals-routing`. Installed Entire 0.11.4; PATH Codex 0.153.4. `entire session current --json` recognized caller `01a12fa6-df57-7177-9eb1-fb739cc42076` but reported no Entire session state. Live capture is unverified; no shared-state status/doctor, hook changes, imports or fabricated checkpoint linkage were used.

## Focused validation

`node --test test/knowledge.test.ts`: 5 passed. Knowledge loader accepts version `2026-10-12.2`, 28 records, and selects `official-eval-fit-and-calibration` first for “How do evals fit my agent?”. New records: `official-eval-fit-and-calibration`, `official-personal-updates`, `synthetic-alert-routing`. Full application and browser validation remain owned by the parent implementation task.
