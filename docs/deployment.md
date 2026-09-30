# Static deployment

Build with `npm ci && npm run build`. Serve `dist/` with relative asset paths. The intended hosted location is `https://kineto.app/kinetik-oss/`; redirect the path without the trailing slash to the slash form so relative manifest and worker paths resolve consistently.

The included server supports `KINETIK_BASE_PATH=/kinetik-oss/`, `KINETIK_KEEP_ALIVE=1`, and an external `KINETIK_PUBLIC_URL`. Put HTTPS in front of it for remote access. Binding to another machine does not move the agent loop there: execution and data remain in the visiting browser.

Serve JavaScript as JavaScript, the manifest as `application/manifest+json`, and avoid immutable caching of `sw.js` or `index.html`. The worker caches a build's app shell, keeping all application assets available after the local server exits. Updates wait for the previous worker's clients to close rather than interrupting active turns. Old caches belonging to this app scope are removed when the replacement activates.

The trusted plugin loader uses `Function`, so the **worker response** needs a CSP allowing string compilation. The included server applies that only to `sw.js`; the UI uses `script-src 'self'` and `frame-src 'self'`. Adjust worker `connect-src` to cover plugin and MCP destinations you intend to permit. Do not apply this setting to the entire Kineto site without review.

A subpath provides routing, not an origin security boundary. Trusted plugins share browser storage and same-origin request privileges with other applications on `kineto.app`. Check the existing root service worker, cookies, CSP, and routing before deploying under the main domain. No production deployment is automated here.

There is no model credential endpoint. No OpenAI token should be inserted into served configuration, URLs, the workspace, or source control. Official model authentication remains unresolved; see the research document.

MCP Apps also need `app-sandbox.html` served with the dedicated CSP from `bin/kinetik.mjs`. Its response permits inline view scripts and HTTPS resources, and enforces `sandbox allow-scripts`. Each inner view adds a restrictive CSP built from its server-declared domains. Do not apply the sandbox's script policy to `index.html` or the main site. Preserve CSP headers when caching these assets. The worker also applies the sandbox CSP to cached proxy responses, and the UI refuses to embed a proxy without that header. Keep `allow-same-origin` out of the response CSP; the frame attribute allows the navigation to pass through the worker, while the response CSP establishes the opaque origin.
