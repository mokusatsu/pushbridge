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
- `POST /api/v1/auth/logout`
- `DELETE /api/v1/auth/sessions/{session_id}`

Public option issuance is IP/action rate-limited. Passkey registration requires Turnstile in production unless explicitly disabled. Authentication errors do not expose verifier internals.

## Local verification

Windows and Linux can run the same make-free command:

```sh
npm run cloudflare:local:passkey-e2e
```

It builds Worker/PWA, applies migrations to a dedicated local D1 persistence directory, starts Wrangler dev, and uses a Chromium virtual authenticator to verify registration, cookie authentication, CSRF-protected mutation, logout, and login.
