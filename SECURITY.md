# Security

This is an early prototype. Only install plugins whose code you trust. Plugins execute with the app origin's privileges, including access to its IndexedDB. Tool schemas and URL checks are input validation, not a plugin sandbox.

The local launcher binds to loopback by default and serves only built static files. A remote deployment needs HTTPS and an explicit review of origin sharing, CSP, and authentication. Local files are virtual; browser site-data deletion removes them.

Do not report credentials or private user data in a public issue. Use GitHub's private vulnerability reporting for this repository when available. If it is unavailable, open an issue asking maintainers for a private reporting channel without disclosing exploit details.

The prototype has no OpenAI login or token storage. MCP bearer settings are browser-local data accessible to trusted plugins. Cancellation of a remote request does not prove that its remote effect was cancelled.
