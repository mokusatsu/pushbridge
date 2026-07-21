# 参照資料一覧

参照記録日: 主に2026-07-13  
本番着手・料金判断・provider更新前に最新内容を再確認すること。

## Pushbulletの公開外形仕様

- Pushbullet API documentation: https://docs.pushbullet.com/
- API v16: https://docs.pushbullet.com/v16
- API v14: https://docs.pushbullet.com/v14
- API v11: https://docs.pushbullet.com/v11
- Pushbullet Help: https://help.pushbullet.com/

設計へ反映した外形的な要素:

- note/link/fileのPush型
- file uploadとPush作成の二段階
- client GUIDによる重複回避
- device指定
- history、dismiss、delete
- realtime streamのtickleと再同期
- channelsの一対多
- Android依存のnotification mirroring
- clipboard monitoring機能の存在

## Cloudflare Workers

- Infrastructure as Code: https://developers.cloudflare.com/workers/platform/infrastructure-as-code/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Static Assets billing and limitations: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Environment variables: https://developers.cloudflare.com/workers/configuration/environment-variables/
- Secrets: https://developers.cloudflare.com/workers/configuration/secrets/

## D1

- D1 documentation: https://developers.cloudflare.com/d1/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- Wrangler D1 commands: https://developers.cloudflare.com/d1/wrangler-commands/
- Foreign keys: https://developers.cloudflare.com/d1/sql-api/foreign-keys/

## R2

- R2 documentation: https://developers.cloudflare.com/r2/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Object lifecycle: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Delete buckets / lifecycle timing: https://developers.cloudflare.com/r2/buckets/delete-buckets/
- User generated content reference architecture: https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/

## Durable Objects

- Durable Objects documentation: https://developers.cloudflare.com/durable-objects/
- Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- WebSocket Hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## Queues

- Queues documentation: https://developers.cloudflare.com/queues/
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/

## Turnstile

- Turnstile documentation: https://developers.cloudflare.com/turnstile/
- Plans: https://developers.cloudflare.com/turnstile/plans/
- Siteverify: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

## Terraform Provider

- Cloudflare Terraform Provider: https://github.com/cloudflare/terraform-provider-cloudflare
- Registry: https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs

既存IaCはCloudflare Provider v5.22.0のresource schemaに対して検証された記録を持つ。対象resource:

- `cloudflare_workers_script`
- `cloudflare_workers_script_subdomain`
- `cloudflare_workers_custom_domain`
- `cloudflare_workers_cron_trigger`
- `cloudflare_d1_database`
- `cloudflare_r2_bucket`
- `cloudflare_r2_bucket_cors`
- `cloudflare_r2_bucket_lifecycle`
- `cloudflare_turnstile_widget`
- `cloudflare_queue`
- `cloudflare_queue_consumer`

## Browser/PWA

- Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- Notifications API: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
- WebAuthn API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
- Service Worker API: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- IndexedDB API: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
- Web App Manifest: https://developer.mozilla.org/en-US/docs/Web/Manifest

## Chromium拡張機能

- Chrome Extensions: https://developer.chrome.com/docs/extensions/
- Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- WebSockets in extension service workers: https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
- Permissions: https://developer.chrome.com/docs/extensions/reference/permissions-list

## iOS/iPadOS PWA Web Push

- Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/

## Standards/security

- Web Authentication Level 3: https://www.w3.org/TR/webauthn-3/
- RFC 5869 HKDF: https://www.rfc-editor.org/rfc/rfc5869
- NIST SP 800-38D GCM: https://csrc.nist.gov/publications/detail/sp/800-38d/final
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/

## 同梱されている元の参照記録

- `cloudflare-iac/REFERENCES.md`
- `cloudflare-iac/VALIDATION.md`
