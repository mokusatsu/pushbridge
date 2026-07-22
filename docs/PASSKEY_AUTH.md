# Passkey authentication

Phase 6 adds standards-based WebAuthn registration and authentication without changing the existing device Bearer flow. The Worker uses `@simplewebauthn/server`; the PWA uses `@simplewebauthn/browser`.

## Deployment gate

Passkeys remain disabled unless both values are explicit:

- `PASSKEY_RP_ID`: hostname only, with no scheme, port, or path
- `PASSKEY_EXPECTED_ORIGINS`: JSON array of exact origins

Terraform exposes these as `passkey_rp_id` and `passkey_expected_origins`. No workers.dev or custom-domain value is inferred. The production hostname and RP ID must be selected together before applying these variables.

Local integration uses RP ID `localhost` and origin `http://localhost:8787`. HTTP is accepted only for localhost development; deployed origins must use HTTPS.

## API flow

Registration:

1. `POST /api/v1/auth/passkeys/registration/options`
2. `navigator.credentials.create()` through SimpleWebAuthn
3. `POST /api/v1/auth/passkeys/registration/verify`

Authentication:

1. `POST /api/v1/auth/passkeys/authentication/options`
2. `navigator.credentials.get()` through SimpleWebAuthn
3. `POST /api/v1/auth/passkeys/authentication/verify`

Challenges expire after five minutes and are consumed once, including failed verification. Credential public keys, counters, transport hints, device type, and backup state are stored in D1. Private keys remain in the authenticator.

## Browser session security

Successful verification issues `__Host-pushbridge_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. The server stores only its SHA-256 hash. Browser sessions have a seven-day idle limit and a thirty-day absolute limit.

Unsafe cookie-authenticated requests require both:

- an `Origin` exactly present in `PASSKEY_EXPECTED_ORIGINS`
- `X-CSRF-Token` matching the hashed token stored with the session

The PWA keeps the CSRF token in `sessionStorage`; it is not stored in the authentication cookie or localStorage. Existing Bearer clients continue to work unchanged.

Session routes:

- `GET /api/v1/auth/sessions`
- `POST /api/v1/auth/session/rotate`
- `POST /api/v1/auth/logout`
- `DELETE /api/v1/auth/sessions/{session_id}`

The PWA rotates the browser cookie and CSRF token when it starts. The previous pair becomes invalid atomically, while a device-scoped cursor secret keeps existing signed sync cursors valid across rotation.

Public option issuance is IP/action rate-limited. Known-account authentication has a separate account limit, and authenticated mutations have a device limit. Passkey registration requires Turnstile in production unless explicitly disabled. `GET /api/v1/auth/config` exposes only the non-secret Site Key and whether the widget is required; the Secret Key remains a Worker secret. Authentication errors do not expose verifier internals.

## One-time device link

Production device enrollment no longer returns a permanent Bearer token to the already-authenticated device. It uses a ten-minute, one-use approval grant:

1. `POST /api/v1/device-links` creates a pending grant and returns its plaintext token once.
2. The new device calls `POST /api/v1/device-links/redeem` without existing authentication.
3. D1 atomically consumes the grant, creates the device, and issues its device-scoped Bearer token.
4. `GET /api/v1/device-links/{link_id}` lets the issuing account observe `pending`, `consumed`, or `expired` without returning the token again.

Concurrent redemption creates exactly one device. Replay and expiry return HTTP 410. The legacy `POST /v1/devices/link` shortcut remains available only outside `APP_ENVIRONMENT=production` for RelayMock and older local tests.

Migration `0009_device_links.sql` adds `devices.cursor_secret` and the `device_links` ledger. SQLite column removal is not a safe rollback path; rollback means retaining schema version 9 and deploying the previous Worker until a forward migration is prepared. The migration does not rewrite existing devices or sessions.

## Local verification

Windows and Linux can run the same make-free command:

```sh
npm run cloudflare:local:passkey-e2e
```

It builds Worker/PWA, applies migrations to a dedicated local D1 persistence directory, starts Wrangler dev, and uses a Chromium virtual authenticator to verify registration, cookie authentication, startup session rotation, CSRF-protected one-time link issuance, redemption from a second browser context, logout, and login.

As of 2026-07-23, dev has D1 schema version 8 and the Phase 6 base Worker deployed. Passkey remains intentionally disabled there because the final Custom Domain, RP ID, and allowed Origin have not been selected. Migration 0009 and the follow-up Worker/PWA update remain a separate approval-gated deployment.
