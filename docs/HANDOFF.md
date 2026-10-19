# Demo Bugfix Handoff

Date: 2026-10-19

## Changes

- Replaced the five active SVG reference-image URLs with 1024×759 PNGs. Decart VTON supports JPEG, PNG, and WebP reference images.
- Combined each image and its garment-specific prompt into one `set_image` message.
- Enabled garment selection before starting and during an active session. During a pending change, further clicks keep the latest choice queued and visibly marked; changes are sent serially.
- Start the 30-second garment acknowledgment timer only after `set_image` is actually sent. Treat an ACK without a `success` field as accepted unless it explicitly reports `success: false`.
- Treat provider errors as session-fatal and clear pending selections, preventing late acknowledgments from being attributed to the next garment when the protocol provides no request ID.
- Guard asynchronous teardown completion with a lifecycle token so an older stop/error cleanup cannot overwrite a newer user action or session state.
- Fixed session start/stop requests: Fastify rejects a request with `Content-Type: application/json` and no body with 400, while the global handler previously returned 500. The client now sends an empty JSON object (no request fields added), and the handler preserves 4xx status codes.
- Restricted CORS and session-changing HTTP/WebSocket requests to configured local app origins, preventing arbitrary websites from creating billable sessions through the local service.
- Classified Vite and its React plugin as client development dependencies; Docker's backend stage now installs only production dependencies for the server workspace instead of copying the full build toolchain.
- Reject `set_image` messages with `null` image data; the demo always sends a base64 garment image, and null could otherwise be forwarded upstream as an invalid reference.
- Kept rejected prompt/image feedback visible and fixed startup and React StrictMode cleanup behavior.
- Bounded browser and server signaling queues, and close a partially-created WebRTC connection if session startup fails.
- Moved source SVGs out of the publicly served client assets and into `assets/garments/source-svg`.
- Limited the server's queued signaling payload by both message count and total bytes, validate required/base64 reference-image data and decoded size, and return the session to `connected` after an image acknowledgment.
- Standardized Node.js on supported 22/24 lines, defaulting to the locally verified `24.18.1` in `.nvmrc`; pinned both Docker Node stages to the same patch version and declared npm `11.16.0` in the root manifest.
- Added in-page garment upload for JPG, PNG, and WebP files up to 10 MiB; uploaded images remain in page memory only and can be selected before or during a session.
- Added the `extension` Chrome MV3 package: clicking an image on an HTTP/HTTPS page opens a 460×820 Anywear popup and passes the image into the compact page. The popup reports a clear startup error when the local app is unavailable.
- Added compact-mode single-column layout rules so the popup remains usable even when its viewport is wider than the intended window size.
- Added a backend Decart API Key pool: `DECART_API_KEYS` accepts comma/newline-separated keys, sessions use least-active round-robin assignment, and upstream connection failures temporarily cool down the affected key. The existing `DECART_API_KEY` setting remains compatible.

## Verification

- `npm run typecheck` and `npm run build` passed after the latest selection fixes.
- Offline `npm ci --dry-run --offline` passed; npm reports an `esbuild` install script awaiting explicit npm approval, but the local build succeeds.
- Focused runtime smoke checks passed for missing/malformed image rejection, successful acknowledgment state recovery, and signaling queue byte-cap enforcement with 10 MiB image payloads.
- Focused WebSocket smoke check confirms queued signals are sent after the offer and the `onSent` callback runs once only after `set_image` is sent.
- Browser check: all five reference images load at 1024×759; selecting a garment while idle updates the heading and pressed state.
- Local health and garment endpoints returned success; current health reports the provider configured with `lucy-vton-3.6`.
- Local HTTP smoke check: creating a session with `{}` returned 201, stopping it returned 200, empty and malformed JSON requests preserved 400, and all five enabled garments were returned. No signaling socket was opened, so the upstream model was not invoked.
- Origin security smoke check: allowed-origin preflight returned the matching CORS header; an unlisted origin received no CORS permission, session creation returned 403, and a WebSocket handshake returned 403 before the handler could connect upstream. No-Origin mutation requests are also rejected.
- Session-manager smoke check: a `set_image` message with `image_data: null` was rejected without queueing; a small valid base64 image was queued, then the test session was stopped.
- After adding the origin guard and production dependency changes, `npm run typecheck`, `npm run build`, and `docker compose config --quiet` passed. Offline npm workspace production-install dry run excludes TypeScript, tsx, Vite, and other development packages. `npm ls --depth=0` is consistent with the manifests and lockfile.
- Browser page remains idle with all five garments visible and the selected garment name and pressed state aligned. Health and garment endpoints returned success.
- `docker compose config --quiet` passed. After the Docker proxy became available, the images built successfully with `DOCKER_BUILDKIT=0`; both containers were recreated and the backend health check passed.
- Final verification: `npm run typecheck`, `npm run build`, extension JavaScript syntax checks, manifest JSON parsing, and `docker compose config --quiet` passed. A local PNG upload entered the garment rail and became selected; compact-mode garment collapse worked; browser console reported no errors. No camera permission or paid generation request was initiated.
- Key-pool verification remains pending until multiple test keys are supplied; no key values are stored in source, logs, or documentation.

## Remaining Risks

- The PNG references are rasterized placeholder illustrations, not product photography; visual try-on quality may remain poor until they are replaced with clean, authorized garment photos.
- A live Decart `set_image_ack` and resulting generated video were not verified.
- Docker Desktop's BuildKit path still failed to fetch the Node metadata in this environment; the verified fallback is `DOCKER_BUILDKIT=0 docker compose build`.
- The repository is anchored at `origin/main`; the current source layout remains separated into client, server, build/deployment config, private source assets, public runtime images, and docs.
