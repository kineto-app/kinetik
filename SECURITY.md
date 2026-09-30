# Security

This is an early prototype. Only install plugins whose code you trust. Plugins execute with the app origin's privileges, including access to its IndexedDB. Tool schemas and URL checks are input validation, not a plugin sandbox.

The local launcher binds to loopback by default and serves only built static files. A remote deployment needs HTTPS and an explicit review of origin sharing, CSP, and authentication. Local files are virtual; browser site-data deletion removes them.

Do not report credentials or private user data in a public issue. Use GitHub's private vulnerability reporting for this repository when available. If it is unavailable, open an issue asking maintainers for a private reporting channel without disclosing exploit details.

Optional experimental ChatGPT browser mode keeps access and refresh tokens only in worker memory. It clears credentials saved by the earlier experimental build. Losing the worker loses the session; this can happen while the PWA is in the background. The short-lived OAuth transaction and public registration identifiers remain in IndexedDB so the copy/paste return flow can survive worker suspension. Tokens never enter workspace files or chat snapshots, but trusted executable plugins and compromised same-origin scripts are not isolated from the app's privileges. Sign out and revoke the app in ChatGPT Settings to remove access. This is not an officially supported browser integration. MCP bearer settings are browser-local data accessible to trusted plugins. Cancellation of a remote request does not prove that its remote effect was cancelled.

MCP App HTML is untrusted. It is hosted in a nested opaque-origin sandbox with a per-resource CSP. Views cannot call another server's tools or model-only tools. Trusted executable plugins have broader privileges and must not be confused with sandboxed App views. App-origin storage and device permissions are intentionally unavailable.

Background work runs enabled tools automatically, up to the configured run limit. It is subject to browser lifetime limits. Push subscriptions should be shared only with the sender you choose; a sender can trigger matching event routines. Event names and payload sizes are validated before persistence.
