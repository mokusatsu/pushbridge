# Phase 5 browser evidence

`phase5-browser-evidence.html` is a self-contained report generated from a real local Playwright Chromium run. It correlates five UI screenshots with sanitized API method/path/status rows and IndexedDB object counts.

The report intentionally excludes authorization headers, bearer tokens, request and response bodies, Web Push endpoints, and file bytes. Names and titles visible in screenshots are synthetic test fixtures.

Regenerate from the repository root after installing the bundled Chromium:

```bash
npm run --prefix apps/web-pwa test:e2e:install
npm run pwa:evidence
```

On Windows, both commands work without `make`.
