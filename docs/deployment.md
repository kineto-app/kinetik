# Static deployment

Build with `npm ci && npm run build`. Serve `dist/` from a dedicated origin with relative asset paths. Redirect a hosting path without its trailing slash to the slash form so relative manifest and worker paths resolve consistently.

## Distributable build

CI runs the full checks, including browser tests, then uploads a `kinetik-static` artifact. Run `npm run check && npm run package:static` from a clean committed checkout to produce it locally. `release/kinetik-oss/` holds the tested static build and MIT license; `release/kinetik-oss.lock.json` records the source commit, build ID, and SHA-256 of every asset. Packaging does not rebuild the browser-tested files. This artifact is for inspection or manual distribution; it does not deploy itself.

## Serving requirements

The included server supports `KINETIK_BASE_PATH=/kinetik-oss/`, `KINETIK_KEEP_ALIVE=1`, and an external `KINETIK_PUBLIC_URL`. Put HTTPS in front of it for remote access. Binding to another machine does not move the agent loop there: execution and data remain in the visiting browser.

Serve JavaScript as JavaScript, the manifest as `application/manifest+json`, and avoid immutable caching of `sw.js` or `index.html`. Each build emits a `version.json` identifier and a distinct worker/cache version. Deploy the complete build together. The worker caches a build's app shell, keeping all application assets available after the local server exits. Downloaded updates show an explicit Update button. A click activates the waiting worker and reloads controlled app tabs, retaining workspace data and composer drafts. Activation refuses while foreground or background work is active; the waiting worker does not initialize or recover the agent runtime. Closing all controlled tabs also permits normal browser activation on the next launch. Old caches belonging to this app scope are removed when the replacement activates.

The trusted plugin loader uses `Function`, so the **worker response** needs a CSP allowing string compilation. The included server applies that only to `sw.js`; the UI uses `script-src 'self'` and `frame-src 'self'`. Adjust worker `connect-src` to cover plugin and MCP destinations you intend to permit. Apply this policy only to the worker response.

A subpath provides routing, not an origin security boundary. Trusted plugins share browser storage and same-origin request privileges with other applications on their origin. Host the app on a dedicated origin. A sibling subdomain also needs a same-site request and CSRF review.

There is no model credential endpoint. No OpenAI token should be inserted into served configuration, URLs, the workspace, or source control. Official model authentication remains unresolved.

MCP Apps also need `app-sandbox.html` served with the dedicated CSP from `bin/kinetik.mjs`. Its response permits inline view scripts and HTTPS resources, and enforces `sandbox allow-scripts`. Each inner view adds a restrictive CSP built from its server-declared domains. Do not apply the sandbox's script policy to `index.html` or the main site. Preserve CSP headers when caching these assets. The worker also applies the sandbox CSP to cached proxy responses, and the UI refuses to embed a proxy without that header. Keep `allow-same-origin` out of the response CSP; the frame attribute allows the navigation to pass through the worker, while the response CSP establishes the opaque origin.
