# Railway deployment preparation

Prepared from settled main `12f7da4784bc88fbb710e7e43d8a4b4edf2bc55f`; animation remains separate. No cloud configuration, credentials, deployment, database transfer, or ledger transfer was performed.

## Existing failed deployment

Reuse project `genuine-prosperity` (`0d07a38a-48bb-49fd-ab4f-f823f498d42d`), production environment `5be2af41-3e72-4ebd-96ff-5bc342747b82`, service `tailor-neathack` (`b32a7cb6-5c49-4ace-8d9b-4994af0fbd25`). Do not create duplicates.

Railway read-only diagnosis context for deployment `ac34818c-2f68-41cd-a1f8-b0ecaf7589c1` confirms source main `12f7da4`, builder RAILPACK, FAILED at BUILD_IMAGE: “Railpack failed to prepare the build. Please check the build logs for more details.” Start command, healthcheck and Dockerfile path were null. No generated diagnosis was available. Build logs expose only scheduling on builder-irapxj at 2026-10-12 15:55:09 UTC; runtime logs empty. These facts do not establish a missing key, incompatible Node version or any more specific cause. Browser/dashboard tools were unavailable in this execution context; parent should inspect the build details read-only for the underlying error.

## Build and service settings

Use root `Dockerfile`, repository root directory, one replica, no autoscaling, no second provider process. Docker pins Node 26.7.0, installs the existing exact lockfile, typechecks, builds browser JS, then prunes development dependencies. SQLite is Node's built-in `node:sqlite`, not an npm native addon; no Python/compiler toolchain is needed for SQLite. The container starts directly with `node src/main.ts` (`npm start` is equivalent), without a shell or npm child swallowing SIGTERM. No secrets or local SQLite/ledger/evidence/hook files are copied into the image.

The same process starts the existing private backend on an ephemeral loopback port, and the existing marketing proxy on `0.0.0.0:$PORT`. Only the proxy is public. Set healthcheck `/healthz`, timeout 120 seconds, restart on failure with at most three retries. Configure one replica and zero deployment overlap; mount the volume at `/data`. Never enable horizontal replicas or an independent Mac/cloud live writer against copied ledgers. This JSON ledger has atomic file replacement but has not demonstrated cross-process atomic reservations.

Do not add legacy railway.json: current Railway documentation says Config as Code is deprecated and new services cannot opt in. Dockerfile plus existing-service dashboard/connector settings is the smallest configuration; no IaC package or database migration introduced.

## Variables (names verified in source)

| Name | Purpose |
| --- | --- |
| `PORT` | Railway-provided public listener port; do not hard-code a Mac preview port. |
| `NODE_ENV` | Docker image sets production. |
| `TAILOR_PUBLIC_ORIGIN` | Newly implemented exact HTTPS public origin, no trailing slash; pins Host and browser Origin. |
| `TAILOR_DATA_PATH` | Explicit absolute persistent SQLite file on the volume. |
| `TAILOR_SPEND_LEDGER` | Explicit absolute persistent cumulative ledger file on the volume, including unknown reservations. |
| `TAILOR_PROVIDER` | Use mock initially; anthropic only after authorized live cutover. |
| `TAILOR_TELEMETRY` | Use captured or disabled initially; neatlogs only after public minimized export scope is approved. |
| `ANTHROPIC_API_KEY` | Live-only secret, supplied privately by owner after approval. |
| `TAILOR_LIVE_CAP_USD` | Existing cumulative runtime ceiling, not a new allocation; public code refuses a ceiling above $19. |
| `TAILOR_MODEL` | Existing live model configuration. |
| `TAILOR_GUARD_MODEL` | Existing guard model configuration. |
| `TAILOR_EFFORT` | Existing planner/explainer effort; guard remains the implementation's low effort. |
| `NEATLOGS_API_KEY` | Hosted telemetry-only secret after separate approval. |
| `TAILOR_NEATLOGS_PROJECT_ID` | Existing approved runtime project verification. |
| `TAILOR_NEATLOGS_PROBE_TRACE_ID` | Previously approved trace used for read-only project verification at startup. |
| `NEATLOGS_ENDPOINT` | Optional existing verified hosted origin. |
| `RAILWAY_GIT_COMMIT_SHA` | Platform-provided optional source revision fallback when container has no Git checkout. |

Leave `TAILOR_DEV_KEY` unset; proxy also hides `/api/dev/*` regardless of a key. Leave `TAILOR_SYNTHETIC_REVIEW_IDS` unset: public mode refuses any nonempty operator payload allowlist. No keys, authentication values or existing browser cookies belong in this document.

## Privacy and limits

Entry now explains fictional inputs, selected model processing, logical demo expiry (four hours or one hour idle), and exclusion of visitor prompt/answer text from technical telemetry. Database/session ownership remains enforced by existing signed HttpOnly SameSite=Strict cookies; public proxy appends Secure. GET refresh and cookie clearing retain Secure too. Raw prompts/answers still reside in the visitor's local server-side conversation and are sent to the selected model when live; the UI does not promise redaction before inference. Logical expiry is not a claim about instant physical deletion from WAL/volume backups.

Existing telemetry allowlist/sensitive-value redaction remains unchanged. Public mode cannot turn on controlled synthetic payload capture. Start with captured/disabled telemetry; separate permission is needed for public hosted minimized diagnostics. No anonymous input is implicitly authorized for raw hosted export.

Public writes require exact browser Origin, public Host is pinned, caller forwarding headers are discarded before reaching private backend. Global fixed-window limits: 30 writes/minute, 10 turn attempts/minute, one turn at a time, 429 and Retry-After on overload. These intentionally shared limits can delay legitimate visitors. They are basic demo controls, not distributed abuse protection. In-process spend reservations retain the existing cap and fail closed on ledger corruption/write failure; multi-process safety remains unverified.

## Owner/account steps before retry

1. In existing service, inspect the failed deployment build details and record the underlying Railpack error if present. Account and connector are already connected; no new project/service is needed.
2. Approve the small deployment branch after review; coordinate animation separately. Select Dockerfile builder/root Dockerfile on the existing service. Set the start/healthcheck/replica/restart settings above; disable overlapping deployment and autoscaling.
3. After approving Railway resource costs, attach one persistent volume to this service at `/data`; do not put SQLite or the ledger on the ephemeral image filesystem. Set explicit persistent paths, provider mock and telemetry captured/disabled.
4. Generate/choose the service HTTPS domain and set its exact origin. Parent owns domain creation and variable changes. Deploy only after public publication approval. Verify marketing `/`, `/manifesto`, `/how-it-works`, handoff `/try-demo` -> `/entry`, static assets, `/demo/:id/...`, session-owned API, and `/healthz`. No custom domain is required for the first verified trial.
5. Before live cutover, separately approve secret transmission and public inference/export scope. Quiesce all paid Mac turns (preserve ports; coordinate runtime changes), wait for pending reservations to settle, record latest cumulative ledger totals and retain unreconciled amounts. Transfer only the numeric cumulative ledger to the persistent cloud volume through the authorized operator workflow; never reset it or create a zero ledger. No need to transfer private local demo SQLite: a fresh cloud SQLite is acceptable, but the spend history must be retained. Verify exact source/target file hash and safe accounting totals, and refuse simultaneous independent live writers. Set live variables privately and keep the existing ceiling; startup refuses a missing live ledger. User's original $20 allowance is cumulative; operational ceiling remains $19. Until this handoff is approved/completed, keep cloud mock-only.
6. Verify production HTTPS cookie/readback and health without model calls, then only the explicitly approved live smoke. Recheck source SHA and minimize/export project evidence separately. Existing localhost 4328/4348/4358/4368 remain untouched by this preparation.

## Resource estimate and verification boundary

Start with one process, a 1 GB volume and a proposed 512 MB memory allowance; these are sizing proposals, not measured cloud requirements or resources created. Railway docs list RAM $10/GB/month, CPU $20/vCPU/month, storage $0.15/GB/month, egress $0.05/GB, Hobby $5/month counting toward usage. Illustratively 0.5 GB sustained RAM + 0.1 sustained vCPU + 1 GB storage is about $7.15/month plus egress and model/API costs; actual usage and billing determine the bill. No load benchmark or reliable monthly traffic forecast exists. Source: https://docs.railway.com/pricing ; https://docs.railway.com/volumes ; https://docs.railway.com/deployments/healthchecks ; https://docs.railway.com/config-as-code .

Verified locally: typecheck, browser bundle build; 23 focused production/proxy/spend/privacy tests pass, including real production-mode mock boot, marketing/demo/assets, independent browser cookie readback, Secure/HttpOnly/SameSite, dev endpoint hiding, Host/Origin rejection, write throttling, serialized turns, missing-ledger/raw-capture/cap refusal, and SIGTERM exit 0. No paid calls. Docker CLI/daemon is unavailable here, so Linux image build and actual Railway deployment are unverified. Hosted telemetry flush uses existing shutdown implementation; network delivery not tested. Entire 0.11.4 reports no state for caller 01a12f26-8424-749c-adff-b171d9f5d048; 138 existing checkpoint refs preserved, live capture/linkage unverified.

## Approved live-only cutover update (supersedes mock-first procedure above)

User approved up to $10 hosting for the first month (trial credit first), existing cumulative API allowance, coordinated Mac-to-cloud cutover and minimized public Neatlogs telemetry. Secret values must be entered personally by the user. No plan upgrade is authorized. Animation is canceled. Parent confirmed staged Dockerfile/start/healthcheck, one replica with overlap0, CPU0.5/memory0.5GB, /data500MB volume and public origin https://tailor-neathack-production.up.railway.app. No mock cloud deployment is authorized.

No Railway CLI or Docker executable is installed here. Connector APIs provide variable staging but no volume-file upload/SSH. A one-time initializer permits numeric-ledger transfer through the existing authorized variable connector: `TAILOR_SPEND_LEDGER_SEED_BASE64` holds the exact bounded numeric version-2 ledger bytes; `TAILOR_SPEND_LEDGER_SEED_SHA256` holds their digest. It requires explicit anthropic/public mode, rejects mismatched hashes/unknown content fields/overwriting a different existing file, and uses exclusive create, mode600 and fsync. It preserves exact pending/unreconciled entries and safety flags; logs only digest and existence status. A partial or mismatched existing file fails startup rather than being overwritten. It authorizes no additional spending.

Sequence: drain and stop the sole Mac live backend, retain its database/ledger and replace port4328 with a clearly labelled maintenance response (no provider or writer). Existing marketing/manual proxy listeners remain. Capture the frozen exact ledger bytes/hash and accounting totals. Parent stages the two non-secret seed variables, and user personally supplies API secrets. Normal branch merge/push follows the confirmed staged config; parent commits deployment settings. Require startup seed digest match and terminal SUCCESS/HTTPS cookie checks, without any model smoke. Immediately clear both seed variables after verified boot, preserving /data/spend-ledger.json. Missing volume/ledger on any later boot then fails closed. Never restart the Mac live provider while cloud is enabled, and never leave an old seed as an automatic reset mechanism.
