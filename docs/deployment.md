# Static deployment

Build with `npm ci && npm run build`. Serve `dist/` with relative asset paths. The planned entry URL is `https://kineto.app/kinetik-oss/`. Production hosting is pending an isolated origin or a plugin execution boundary; a subpath alone is insufficient. Redirect any hosting path without its trailing slash to the slash form so relative manifest and worker paths resolve consistently.

## Build handoff to Kineto

CI runs the full checks, including browser tests, then uploads a `kinetik-static` artifact. Run `npm run check && npm run package:static` from a clean committed checkout to produce it locally. `release/kinetik-oss/` holds the tested static build and MIT license; `release/kinetik-oss.lock.json` records the source commit, build ID, and SHA-256 of every asset. Packaging does not rebuild the browser-tested files. This artifact is for inspection or manual distribution; it does not deploy itself.

The companion Kineto integration resolves this repository's latest `main` at the start of every frontend deployment build. It uses a clean checkout, runs `npm ci`, typechecking, unit/integration tests and the production build, then includes the result in the frontend image. A fetch, test, or build failure stops deployment instead of falling back to an older bundle. The frontend image build verifies every asset against the generated lockfile.

Both dev and production frontend jobs resolve `main` independently. Production can therefore include a newer Kinetik commit than the previous dev build. The lockfile attached to each frontend build identifies the exact revision. Kineto's combined FE/BE release includes this frontend job; backend-only deployments do not update Kinetik. While this repository is private, the jobs need a read-only `KINETIK_GITHUB_TOKEN`; credentials are used only for fetching source and are not passed to npm scripts or included in the image. Set it as a protected TeamCity password environment parameter for both frontend jobs.

The integration PR initially blocks production requests under `/kinetik-oss/` until hosting isolation is configured. Building and bundling the app does not enable its production route or connect ChatGPT. Users of an installed PWA still decide when to activate a downloaded update.

## Serving requirements

The included server supports `KINETIK_BASE_PATH=/kinetik-oss/`, `KINETIK_KEEP_ALIVE=1`, and an external `KINETIK_PUBLIC_URL`. Put HTTPS in front of it for remote access. Binding to another machine does not move the agent loop there: execution and data remain in the visiting browser.

Serve JavaScript as JavaScript, the manifest as `application/manifest+json`, and avoid immutable caching of `sw.js` or `index.html`. Each build emits a `version.json` identifier and a distinct worker/cache version. Deploy the complete build together. The worker caches a build's app shell, keeping all application assets available after the local server exits. Downloaded updates show an explicit Update button. A click activates the waiting worker and reloads controlled app tabs, retaining workspace data and composer drafts. Activation refuses while foreground or background work is active; the waiting worker does not initialize or recover the agent runtime. Closing all controlled tabs also permits normal browser activation on the next launch. Old caches belonging to this app scope are removed when the replacement activates.

The trusted plugin loader uses `Function`, so the **worker response** needs a CSP allowing string compilation. The included server applies that only to `sw.js`; the UI uses `script-src 'self'` and `frame-src 'self'`. Adjust worker `connect-src` to cover plugin and MCP destinations you intend to permit. Do not apply this setting to the entire Kineto site without review.

A subpath provides routing, not an origin security boundary. Trusted plugins share browser storage and same-origin request privileges with other applications on their origin. Serving this runtime on Kineto's authenticated origin would grant plugins access to the user's Kineto account. Use a separate site, or implement a plugin execution boundary before enabling that route. A sibling subdomain still needs a same-site request/CSRF review. No production hosting is enabled by this repository's CI.

There is no model credential endpoint. No OpenAI token should be inserted into served configuration, URLs, the workspace, or source control. Official model authentication remains unresolved; see the research document.

MCP Apps also need `app-sandbox.html` served with the dedicated CSP from `bin/kinetik.mjs`. Its response permits inline view scripts and HTTPS resources, and enforces `sandbox allow-scripts`. Each inner view adds a restrictive CSP built from its server-declared domains. Do not apply the sandbox's script policy to `index.html` or the main site. Preserve CSP headers when caching these assets. The worker also applies the sandbox CSP to cached proxy responses, and the UI refuses to embed a proxy without that header. Keep `allow-same-origin` out of the response CSP; the frame attribute allows the navigation to pass through the worker, while the response CSP establishes the opaque origin.
