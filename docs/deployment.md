# Static deployment

Build with `npm ci && npm run build`. Serve `dist/` from a dedicated origin with relative asset paths. Redirect a hosting path without its trailing slash to the slash form so relative manifest and worker paths resolve consistently.

## Distributable build

CI runs the full checks, including browser tests, then uploads a `kinetik-static` artifact. Run `npm run check && npm run package:static` from a clean committed checkout to produce it locally. `release/kinetik-oss/` holds the tested static build and MIT license; `release/kinetik-oss.lock.json` records the source commit, build ID, and SHA-256 of every asset. Packaging does not rebuild the browser-tested files. This artifact is for inspection or manual distribution; it does not deploy itself.

## Serving requirements

The included server supports `KINETIK_BASE_PATH=/kinetik-oss/`, `KINETIK_KEEP_ALIVE=1`, and an external `KINETIK_PUBLIC_URL`. Put HTTPS in front of it for remote access. Binding to another machine does not move the agent loop there: execution and data remain in the visiting browser.

Serve JavaScript as JavaScript, the manifest as `application/manifest+json`, and avoid immutable caching of `sw.js` or `index.html`. Each build emits a `version.json` identifier and a distinct worker/cache version. Deploy the complete build together. The worker caches a build's app shell, keeping all application assets available after the local server exits. Downloaded updates show a compact, sticky update bar on every screen, including installation, sign-in, dialogs, and the mobile chat menu. The same Update control follows the active screen, so it remains reachable without closing setup. A click activates the waiting worker and reloads controlled app tabs, retaining workspace data and composer drafts. Activation refuses while foreground or background work is active; the waiting worker does not initialize or recover the agent runtime. Closing all controlled tabs also permits normal browser activation on the next launch. Old caches belonging to this app scope are removed when the replacement activates.

The trusted plugin loader uses `Function`, so the **worker response** needs a CSP allowing string compilation. The included server applies that only to `sw.js`; the UI uses `script-src 'self'` and `frame-src 'self'`. Adjust worker `connect-src` to cover plugin and MCP destinations you intend to permit. Apply this policy only to the worker response.

A subpath provides routing, not an origin security boundary. Trusted plugins share browser storage and same-origin request privileges with other applications on their origin. Host the app on a dedicated origin. A sibling subdomain also needs a same-site request and CSRF review.

The standalone build does not provide a model credential server. No OpenAI token should be inserted into served configuration, URLs, the workspace, or source control. Hosts that already supply a credential helper can opt into the contract below.

MCP Apps also need `app-sandbox.html` served with the dedicated CSP from `bin/kinetik.mjs`. Its response permits inline view scripts and HTTPS resources, and enforces `sandbox allow-scripts`. Each inner view adds a restrictive CSP built from its server-declared domains. Do not apply the sandbox's script policy to `index.html` or the main site. Preserve CSP headers when caching these assets. The worker also applies the sandbox CSP to cached proxy responses, and the UI refuses to embed a proxy without that header. Keep `allow-same-origin` out of the response CSP; the frame attribute allows the navigation to pass through the worker, while the response CSP establishes the opaque origin.

## Connections and guided setup

Serve deployment-owned `config.json` beside `index.html` with `Cache-Control: no-store`. The default file has no configured connections. A known Charms preset enables the `?connect=charms` entry point:

```json
{
  "connections": {
    "charms": {
      "url": "https://service.example/mcp",
      "resource": "https://service.example/mcp",
      "issuer": "https://service.example/oauth",
      "metadataUrl": "https://service.example/.well-known/oauth-authorization-server/oauth"
    }
  }
}
```

`resource` is the canonical OAuth resource identifier, even when `url` is a same-origin relay. `metadataUrl` must return the configured issuer, S256 PKCE support, public-client authentication (`none`), code responses, and authorization, registration, and token endpoints. Backchannel endpoints may use the app’s origin for a fixed-endpoint relay; the authorization page must belong to the issuer’s origin. Use HTTPS outside localhost. Direct requests need CORS; a relay must strip cookies, restrict upstream targets and methods, reject redirects, and preserve relevant MCP headers. The callback returns to the app root with `connection_callback=charms`; the app consumes the code and removes callback parameters from the address bar. Neither OAuth endpoints nor plugin source URLs come from deep-link parameters.

The guided flow offers ChatGPT sign-in, prepares Charms, obtains authorization, verifies its tools, and loads native skills. Existing connections skip completed steps. Charms callbacks complete automatically when the browser can access the matching stored authorization request. If an installed app and its external browser use separate storage, the return page offers copy/paste as a fallback. The worker validates the full state and PKCE request in either case.

If tool or skill loading fails after sign-in, the setup clears the consumed return link and offers Enable Charms to retry activation with the saved credential. A manually disabled connection requires an explicit Turn on action in **Settings → Connections → Charms**. The sidebar **Connections** button reopens the guided flow only while ChatGPT or Charms is missing; once both are connected or Charms was turned off on purpose, it opens **Settings → Connections**. If the deployment configuration changes, existing settings are preserved rather than silently redirecting credentials to a new service.

### App details

An optional `app` section tells users about the service behind the build. Every field is optional; a feature whose field is unset stays hidden. Native builds read the same section from their embedded configuration.

```json
{
  "app": {
    "privacyUrl": "https://service.example/privacy",
    "accountUrl": "https://service.example/account",
    "supportEmail": "help@service.example",
    "serviceName": "Example Service",
    "clientName": "Example App"
  }
}
```

- `privacyUrl`: **Settings → Privacy policy**, and a **Privacy** link beside each connection step's consent line.
- `accountUrl`: **Settings → Manage account**, where users manage or delete their account.
- `supportEmail`: a **Report reply** action on each reply. After a short confirmation it opens an email to this address with the reply text, the app version and the platform.
- `serviceName`: names the service in the Charms consent line, "Skills run on Example Service's servers with the files you share." Without it the line says "the service's servers".
- `clientName`: the app name sign-in pages show, both for ChatGPT and in the client registration with the configured connection. Without it, both use `Kinetik OSS`.

Addresses must be absolute HTTPS without credentials, query strings or fragments. `supportEmail` must be a plain address, and names are at most 60 characters. An invalid section fails configuration loading like an invalid connection.

Every MCP request to the configured connection carries `X-Client-Platform`: `web` (installed web apps included), `ios`, `android`, `macos`, `windows` or `linux`. Its CORS policy must allow that header. Sign-in and file upload requests do not carry it.

For experimental browser-owned sign-in, add:

```json
{ "connections": {}, "chatgpt": { "mode": "browser", "jwksUrl": "./connections/chatgpt/keys" } }
```

The host must serve OpenAI's public `https://auth.openai.com/.well-known/jwks.json`
through the same-origin `jwksUrl`, without forwarding cookies, credentials, or redirects.
This endpoint returns public signing keys only. OAuth code exchange, refresh and revocation
travel directly between the browser worker and OpenAI. Model requests are direct by default,
which requires OpenAI to allow the browser origin through CORS. A successful token exchange
does not prove that authenticated model responses are readable. The paste-back flow checks state,
PKCE, the ID-token signature, issuer, audience, nonce, expiry and plan permission. Credentials
are saved in a dedicated browser-local IndexedDB database, separately from workspace files and chat. Login survives worker termination, app restarts and updates. Refresh requests read and update that shared record under a Web Lock, so multiple workers cannot rotate the same token concurrently. Logout removes the record before remote revocation. Browser data clearing, storage eviction or revoked access still require signing in again. The short-lived OAuth transaction and public registration persist in IndexedDB to support the return flow. Trusted plugins still share
origin privileges. This mode deliberately departs from OpenAI's documented token-storage
guidance and has no claim of official browser support. Use it only on a trusted personal device.

The built-in browser ChatGPT connection defaults to `gpt-6.1-sol` with `reasoning.effort: "medium"`. Users can choose another listed model and any reasoning level its catalog entry supports, except `ultra`, which needs Codex task delegation. It checks account access through the model catalog at sign-in and when migrating a saved selection. The optional external credential helper continues to own its model selection.

For an experimental stateless model relay, extend the browser configuration:

```json
{
  "connections": {},
  "chatgpt": {
    "mode": "browser",
    "jwksUrl": "./connections/chatgpt/keys",
    "modelRelay": "./connections/chatgpt/model/"
  }
}
```

`modelRelay` must be on the app's origin and end in `/`. The worker sends authenticated
`POST models` with `{}` and `POST responses` with the Responses API request body.
The host forwards these to `GET https://api.openai.com/v1/models` and
`POST https://api.openai.com/v1/responses`. OAuth and refresh tokens do not use the relay.
The relay receives the access token and prompt in transit. It must not log or persist them,
forward cookies, accept arbitrary upstream URLs, or follow redirects. Enforce the exact
request origin, bound request sizes, preserve streaming and cancellation, and return 429
with `Retry-After` when rate limited. Force `store: false` and `stream: true`. Do not cache
responses. This repository supplies the client contract; the host implements the relay.
This experimental transport does not establish official support for hosted subscription use.

For an existing credential helper, add:

```json
{ "connections": {}, "chatgpt": { "apiBase": "./connections/chatgpt/" } }
```

The same-origin helper contract is `GET status` returning `{connected, model, account?}`, plus `POST login` returning `{url}`, `POST callback` accepting `{url}`, `POST logout`, and `POST responses` accepting `{account, request}` and streaming Responses API SSE. Mutations carry `X-Kinetik-Request: 1`; the helper must enforce the exact request origin, authenticate its own session, validate OAuth state/PKCE and the callback, and retain OpenAI credentials outside the browser. The UI accepts only `https://auth.openai.com` sign-in destinations. Do not expose a generic unauthenticated model proxy.

Helper paths belong under `connections/` so the service worker never returns cached app HTML for them. No helper is included or started automatically. Configuring one changes the host’s model provider, not the launcher’s mandatory-exit behavior. An offline worker reuses its last valid public configuration; it does not turn failed authenticated requests into mock responses.

## Optional installation

Kinetik works in a browser tab or as an installed PWA. Install is an optional action in
setup and the chat sidebar; it never blocks ChatGPT or Charms sign-in. The legacy
`"installation": { "required": true }` configuration still opens hosted account setup
and prepares Charms, but no longer requires installation. Existing hosts need no config change.

The account flow is ChatGPT → Charms → Ready. Chrome and Edge receive the native
install prompt when available. iPhone and iPad get Home Screen instructions, and
Safari on Mac gets Add to Dock instructions. Users can continue in the browser at
any point without installing.

Charms uses an ordinary OAuth redirect in a separate tab, keeping the chat and its
active model request available in both browser and installed-app mode. When both share the stored authorization
request, the callback connects automatically and closes the return tab. The app
refreshes its connection when focused. Separate browser/PWA storage falls back to
a return link that the user pastes into the initiating app. No authorization code is
consumed in a context without the matching request. ChatGPT's localhost callback
continues to use its separate copy/paste flow.
