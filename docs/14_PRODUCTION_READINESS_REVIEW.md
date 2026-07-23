# Production readiness review

Review date: 2026-07-24  
Reviewed implementation commit: `09526d4`  
Validation baseline: `VALIDATION_2026-07-21.md`

## Verdict

The Cloudflare development PoC is suitable for continued use behind Cloudflare
Access. It is not approved for public registration.

Internal-alpha functionality is demonstrated in the deployed dev environment.
Invite-beta functionality is substantially implemented, but the production
File transport and independent security review are incomplete. Public
registration additionally requires an operator domain, policy documents,
alert delivery, and a larger capacity exercise.

## Release-gate evidence

| Gate | Status | Authoritative evidence |
|---|---|---|
| Terraform backend and drift | Pass | Remote state diagnostic returns all required outputs; post-apply Plan is `No changes` |
| D1 migrations | Pass | Remote schema version 12; migrations 0001 through 0012; isolated export/restore drill passes |
| Note/Link sync | Pass | Local and remote two-device Bearer, idempotency, signed cursor, offline recovery tests |
| File server-ticket path | Pass | 0 byte, normal, 25 MiB, oversize, hash/size mismatch, IDOR, 410, retry and cleanup tests |
| R2 presigned direct path | Blocked | SigV4 adapter and local tests are deployed dormant; dedicated R2 S3 credentials and real R2 PUT/GET evidence are missing |
| IndexedDB/local persistence | Pass | Playwright and closed-PWA Web Push prove automatic Blob commit and use after server deletion |
| Retention/pressure cleanup | Pass for PoC | Acceptance cases 1 through 10, fault injection, remote Cron invocation, 507 and alias/tombstone behavior are covered |
| Web Push | Pass for dev | Real Edge PushManager delivery while the PWA is closed, decrypt, IndexedDB commit and cached ACK |
| Realtime | Pass for dev | One-time ticket, Durable Object tickle, REST cursor recovery, reconnect and revoke tests |
| Passkey/session | Local pass; remote blocked | WebAuthn, Origin, CSRF, rotation, replay and revoke tests pass locally; Custom Domain/RP ID is intentionally unset |
| E2EE | Pass for PoC | P-256, HKDF-SHA-256, AES-256-GCM, envelopes, File container, test vectors and plaintext audits |
| Chromium extension | Pass for dev | MV3 minimal permissions, device link, Note/Link/File, WebSocket, notification and peer decrypt in local/dev Chromium |
| Account deletion | Pass for dev | Immediate auth revoke, resumable R2/D1 cleanup, local identity wipe and both remote device tokens returning 401 |
| Linux CI | Pass | GitHub Actions runs #21 through #23, through commit `b443120`, completed successfully on Node 22 |
| Monitoring/alerts | Partial | Synthetic and metrics scripts pass; scheduled/manual workflows require default-branch merge and repository secrets; notification email is unset |
| Capacity | Baseline only | Bounded 251-request dev run has zero errors and one idempotent Push; long soak/reconnect storm/direct-R2 load remain |

## Required external inputs

These values must not be inferred:

1. Dedicated bucket-scoped R2 S3 Access Key ID and Secret Access Key.
2. Final HTTPS Custom Domain, Passkey RP ID, and exact allowed origin.
3. Notification recipient email.
4. Repository secret values for `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET`.
5. Public privacy/terms/support destinations and abuse/incident ownership.

The R2 application credentials must not reuse the Terraform backend `AWS_*`
credentials. `npm run cloudflare:r2-direct:render` enforces this boundary and
writes only an ignored `r2-direct.auto.tfvars`.

## Remaining executable gates

After the R2 credentials are supplied:

1. Render the ignored tfvars and create a saved Terraform Plan.
2. Stop if the Plan contains delete or replacement; otherwise apply the
   Worker binding update.
3. Confirm `direct_upload=true`.
4. Run real presigned PUT/complete/download tests for 0 byte, normal, and
   25 MiB encrypted objects, including URL expiry, overwrite rejection,
   wrong hash, one-use exchange ticket and fixture cleanup.
5. Run remote PWA Playwright again and verify the upload does not traverse the
   Worker body path.

After the Custom Domain is selected, enable Passkey only when RP ID and exact
origins are reviewed together. Cloudflare Access remains enabled until that
remote authentication gate passes.

## Change-management boundary

- Current development branch: `codex/phase9-extension`.
- `remote-smoke.yml` and `cloudflare-monitor.yml` are not dispatchable until
  their workflow files reach the default branch.
- No PR or merge is implied by this review.
- Any future Terraform apply must record add/change/destroy counts and must
  stop on D1, R2, or Worker replacement/deletion.
