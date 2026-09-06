# Compressed HLS playlist reproduction

Tested source: `45e0778dcf1d2b64dafd836d538724a2b4e0b997`, package version **1.55.7**,
with the test changes in this checkout. No separate 1.55.3 run was performed.
Environment: Linux, Node 24.20.0, Vitest 3.2.4 / WebdriverIO, Chrome 152.0.7977.64 (headless).

Run from the repository root:

```sh
npm ci
npm run pre-test
npx vitest run --project browser test/browser/hls-compression.test.ts --browser.headless
```

Uses the existing browser runner and CanvasSource/BufferTarget MPEG-TS generation pattern.
The test creates two AVC frames at timestamps 0 and 0.5 seconds; no media files are downloaded.
The Vitest page and HTTP media server have different loopback origins. The media server uses
an ephemeral port, `Access-Control-Allow-Origin: *`, and no exposed headers. It ignores Range
and sends HTTP 200 with the correct body Content-Length. Each test closes its server in `finally`.

Expected: every case reads the complete segment filename and both encoded packets.
Actual, repeated on this checkout: **2 passed, 2 failed**, exit code 1.

| Case | Actual result |
| --- | --- |
| `plain` | Pass: full segment request, HTTP 200, timestamps `[0, 0.5]`. |
| `br` | Fail: the server sends HTTP 200 to `Range: bytes=0-`, but browser fetch rejects with `TypeError: Failed to fetch`; no segment request. |
| `br-no-range` | Fail: test-only fetch function removes Range from playlist requests. Mediabunny requests a truncated segment filename and receives HTTP 404. |
| `br-no-range-no-size` | Pass: same diagnostic request, plus a test-only response wrapper omitting Content-Length/Content-Range; full segment request and both packets. |

Native fetch passes in all four cases: `response.type === 'cors'`, HTTP 200, and exact equality
with the generated **4,299-byte** decoded playlist. JavaScript sees only these response headers:

```text
cache-control: no-store
content-length: 4299 (plain) / 107 (Brotli)
content-type: application/vnd.apple.mpegurl
```

`response.headers.get('content-encoding')` is null. The server sends `Content-Encoding: br`
for Brotli responses; the browser performs decompression under its normal CORS rules.
The intended filename is `segment-` + 160 `a` characters + `.ts`.
The playlist prefix ending at decoded byte 107 ends with:

```text
segment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

That exact partial filename is requested in `br-no-range`. The server logs native and library
playlist requests, Range values, segment paths, and statuses; the test prints these even on failure.
Assertions require the complete filename and packets, rather than treating the bug as success.

The diagnostic comparison supports the compressed-length/decoded-length hypothesis in current
source. It does **not** establish that the unmodified browser path reaches truncation in this Chrome
version: that path fails earlier. The reason for Chrome's rejection was not established. No browser
access controls were disabled. The diagnostic wrappers are confined to this test, use native fetch,
and are not proposed as application workarounds. This fixture has no redirects, authentication,
live updates, or range-capable server; it does not claim coverage of those conditions.

Verification: targeted ESLint and `npx tsc -p tsconfig.vitest.json --noEmit` pass. The repository
typecheck stages passed after removing the previous standalone harness; the scripts and Vite
typecheck stages were rerun with `npx tsc -p scripts --noEmit` and
`npx tsc -p tsconfig.vite.json --noEmit`. Production source and dependency manifests are unchanged.
