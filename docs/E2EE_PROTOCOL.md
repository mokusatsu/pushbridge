# Pushbridge E2EE protocol v1

This document fixes the cryptographic wire format used by Phase 7. The Worker, D1, R2, Web Push, and logs are untrusted for content confidentiality. They may observe account/device identifiers, routing, timestamps, sizes, retention policy, and delivery state, but never Note titles/bodies, Link URLs, original filenames, MIME types, or File bytes.

## Primitives and encodings

- Device agreement key: P-256 ECDH. Public keys are uncompressed SEC1 points prefixed with `p256.` and base64url without padding.
- Key derivation: HKDF-SHA-256.
- Authenticated encryption: AES-256-GCM with a 96-bit nonce and 128-bit tag.
- Binary fields: unpadded base64url.
- Account content key: 256 random bits, versioned from `1`.
- Recovery key: 256 random bits shown/exported to the user and never uploaded in plaintext.

Every encryption uses a fresh 128-bit salt and 96-bit nonce. The browser nonce generator rejects duplicates observed in the current runtime. A repeated nonce remains separated by a newly derived key because the HKDF salt is also fresh.

## Account and device envelopes

Each browser creates a non-exported P-256 private key in IndexedDB. The account content key is wrapped independently for each active device:

1. The sender creates an ephemeral P-256 key.
2. ECDH derives 256 shared bits with the recipient public key.
3. HKDF uses the envelope salt and `pushbridge/device-envelope/v1/<device-id>/<key-version>`.
4. AES-GCM encrypts the raw 32-byte account key with the same string as AAD.

The opaque JSON envelope contains `v`, `alg`, `key_version`, `recipient_device_id`, `ephemeral_public_key`, `salt`, `nonce`, and `ciphertext`. The server rejects envelope creation for a missing, cross-account, or revoked device.

The recovery envelope derives an AES key from the recovery key using HKDF info `pushbridge/recovery-envelope/v1/<key-version>`. Only the encrypted account key, salt, and nonce are uploaded. Possession of the recovery key is therefore required to recover an account on a device that has no device envelope.

## Push content envelope

Note, Link, and File metadata use `payload_version=2`. HKDF info is `pushbridge/content/v2/<key-version>` and AAD is:

```text
pushbridge/push/v2/<type>/<client-guid>
```

The REST body carries `key_version`, `encryption_salt`, `nonce`, and `ciphertext`; `payload` must be absent. The decrypted JSON is the existing logical payload. For File pushes this includes original filename, MIME type, title, and body. Search is performed only after decryption in the client.

## Encrypted File container

The uploaded R2 object is a binary `PBFE` container:

```text
magic(4) | format-version(1) | key-version(4, big endian) |
salt(16) | nonce(12) | AES-GCM ciphertext-and-tag
```

HKDF info is `pushbridge/file/v1/<key-version>` and AAD is `pushbridge/file/v1/<client-file-id>`. File init uses the opaque server metadata `encrypted.bin` and `application/octet-stream`; only ciphertext size and ciphertext SHA-256 reach the server. The client decrypts before committing the Blob to IndexedDB.

## Web Push and revocation

Web Push payloads contain only opaque IDs, one-use delivery tokens, and routing state. They never contain decrypted content or account keys. A revoked device remains able to decrypt material it already received, but the Worker rejects new device-envelope writes for it and active devices do not provision newer account-key versions to it.

## Versioning and failure behavior

Unknown envelope or File-container versions fail closed. AES-GCM authentication failure, modified AAD, wrong keys, invalid public keys, malformed base64url, and truncated containers are indistinguishable to callers and do not yield partial plaintext.

As of 2026-07-23, Worker, PWA, Service Worker, OpenAPI, fixed vectors, and the two-browser Wrangler E2E pass locally with `REQUIRE_E2EE=true`. Terraform defaults the flag to `false`; dev remains disabled until migrations `0009` and `0010` and the matching Worker plan receive explicit remote-change approval.
