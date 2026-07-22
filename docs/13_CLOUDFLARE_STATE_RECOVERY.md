# Cloudflare state recovery record (2026-07-22)

## Current status

- The remote backend below is connected and its diagnostic reports all required outputs.
- D1 migrations 0001 and 0002, the real Worker API, PWA Static Assets, R2, Durable Object namespace, Turnstile, Cron, and Access are deployed to dev.
- Local Note smoke passes. A prior allowlisted remote Note smoke passed; the current execution environment is outside the allowlist and its protected rerun is rejected by Access.
- The workers.dev hostname is protected by a Terraform-managed Access IP allowlist whose actual CIDRs live only in the ignored `terraform.tfvars`.
- Revalidation found a stale Access state ID with no corresponding API resource. A Plan containing only one Access create was applied, then the API resource and denied unauthorised requests were verified. No D1, R2, or Worker replacement was applied.

The observations below retain the original empty-state recovery chronology. References to a Dashboard template describe pre-recovery evidence, not the current deployment.

## Confirmed root cause

- Terraform module: `infra/cloudflare/infra`
- Backend: S3-compatible R2
- Bucket: `pushbridge-terraform-state`
- Key: `pushbridge/dev/terraform.tfstate`
- Workspace: `default`
- The local `.terraform/terraform.tfstate` backend metadata matched that bucket, key, endpoint, and workspace.
- Before recovery, a complete S3 `ListObjectsV2` returned zero objects and both `terraform state pull` and `terraform state list` reported no state.
- Cloudflare had no D1 database or application R2 bucket. It only had a separately created Dashboard template Worker named `pushbridge-dev`, with its workers.dev route enabled.

The working directory and backend selection were correct. The application state had never been written to the configured remote backend, and most application resources had never been created. The error was therefore not fixed by changing `-chdir` or re-running `terraform init`.

## Imported objects

The state bucket itself is intentionally outside this Terraform stack. The two existing objects that matched configured Terraform addresses were imported using the provider v5.22 `<account_id>/<script_name>` ID form:

| Terraform address | Existing object |
| --- | --- |
| `cloudflare_workers_script.app` | Worker `pushbridge-dev` |
| `cloudflare_workers_script_subdomain.app` | enabled `pushbridge-dev` workers.dev route |

D1, the application R2 bucket and its CORS/lifecycle, Turnstile, and cron did not exist and were not imported as placeholders. Import changed only Terraform state; it did not deploy or modify the public Worker.

After import, remote `terraform state list` contains exactly those two managed addresses. Protected state backups and reviewed binary plans were saved outside Git under the operating-system temporary directory.

## Reviewed recovery plan

- A refresh-only plan has zero resource changes. It reports output-only updates because outputs referring to resources that do not yet exist are currently unavailable; that output update has not been applied.
- The aligned normal plan is `6 add, 1 update, 0 destroy`.
- The six additions are D1, the application R2 bucket, R2 CORS, R2 lifecycle, Turnstile, and the cleanup cron.
- The single update replaces the Dashboard template content with the real Worker/API/PWA and adds its D1, R2, Durable Object, variables, assets, and migration configuration.
- The existing `2026-07-21` compatibility date and detailed observability settings are preserved by the plan.
- The workers.dev subdomain is a no-op.
- The public `/healthz`, `/api/bootstrap/status`, and `/api/v1/system/capabilities` endpoints still return the unchanged Dashboard template response after import.

After the approved normal plan was applied, the first follow-up plan exposed an order-only drift in the Turnstile domain list. Cloudflare returned the same two domains in a different order, which made the provider recompute the Turnstile secret and then plan a dependent Worker secret-binding update. `local.app_hostnames` is now sorted before it reaches the provider so this set-like API field converges across refreshes.

The first public check also showed that `/healthz` was being handled by the SPA fallback. The Terraform Static Assets configuration now includes `/health` and `/healthz` in `run_worker_first`, matching the local Wrangler configuration and ensuring health checks reach the Worker.

The first attempt to apply that routing-only update was rejected with Cloudflare error `10079`: the provider resent the already-applied initial Durable Object migration without `old_tag`. Provider v5 does not retain this write-only migration payload in state. Worker migrations are therefore exposed as nullable, one-shot `durable_object_migration` input: supply it only for the apply that advances the tag, then return it to `null`. The rejected request did not modify the Worker.

## Completed environment

- The approved application plan completed with `6 added, 1 changed, 0 destroyed`.
- The approved health-route correction completed with `0 added, 1 changed, 0 destroyed` after removing the already-applied one-shot Durable Object migration payload.
- D1 migrations `0001_initial.sql` and `0002_application_api.sql` are applied. Remote schema version is `2`, all 11 application tables exist, and Wrangler reports no pending migrations.
- The final Terraform plan returns detailed exit code `0` (no drift).
- `/healthz` returns Worker JSON with HTTP 200. Bootstrap status reports D1, R2, and Durable Object bindings. Capabilities reports the real `0.2.0-worker-poc` API.
- The remote smoke test passes device registration, Bearer enforcement, a two-device Note transfer, idempotent replay, conflict rejection, cursor delta sync, PWA assets, SPA fallback, and Service Worker delivery.
- The deployed PWA was also exercised in a browser: bootstrap and same-origin API sync succeeded, a Note was sent, and the per-user IndexedDB view showed one cached Push. A separate local browser test verified that the same cached Note remains visible after the Worker is stopped and the PWA is reloaded offline.
- The first Linux CI run revealed that the local Wrangler config still referenced the former `apps/web-pwa/dist` output. Windows had a stale local copy, while a clean runner did not. Local Wrangler now serves the same `infra/cloudflare/app/dist` artifact produced by Vite and used by Terraform.
- Linux CI also required terminating the complete `npx`/Wrangler process group after the smoke test; killing only the `npx` parent left Wrangler holding the output pipes and prevented the job from completing. Windows continues to use `taskkill /t`.

The R2 CORS/lifecycle resources carry a provider warning that later removal may require manual Cloudflare cleanup.

Use `npm run cloudflare:state:diagnose` from any working directory to classify backend, state, and required-output failures without printing state contents or secret values. The completed environment reports `state_and_required_outputs_available`.
