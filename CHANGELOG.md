# Changelog

## Unreleased

- Choose a reasoning level for the current ChatGPT model from the composer's model menu. Add several files at once from the file picker on web and Android.

- Show attached photos as thumbnails in the composer and as a swipeable row of photos and file cards in sent messages, with a full-screen photo viewer. Move the model picker into the composer as an icon that opens a list, or a bottom sheet on phones. Keep the one-line composer pill-shaped.

- Add required installation for configured hosted apps, device-specific install guidance, and resumable account setup inside the installed PWA. Local repository runs skip installation.

- Add guided Charms and ChatGPT connection setup, trusted preset deep links, Charms OAuth with PKCE, credential-separated plugin bindings, and an optional same-origin model-helper contract. Preserve manually disabled connections and partition skills by login.

- Refine the chat layout, add formatted replies and copy controls, preserve reading position with a jump-to-latest action, and add reduced-motion-aware interaction transitions.

- Simplified chat for nontechnical users: everyday preview examples, browsable local files with Open/Download cards, plain progress labels, and connection setup under Settings.

- Offer downloaded PWA updates with an explicit Update button, retain unsent drafts across tab reloads, and keep the current build usable when downloads fail. Refuse activation during active work and defer runtime recovery until worker activation.
- Show background execution as an activity indicator, hide raw job results and background tool activity from chat, and retain only useful assistant replies. Rename scheduled-work navigation to Routines.
- Route background completions and user messages through the same steering queue. Batch queued context at safe boundaries and prevent stale model responses from executing tools after new steering arrives.

- Preserve streamed OpenAI output items when the terminal response has an empty output array, as observed during a real ChatGPT subscription test.

- Add background tool processes that release the agent turn and wake the same conversation with a durable completion result. Include cancellation, plugin completion hooks, remote recovery and interruption reporting without replay.

## 0.1.0 - Unreleased

- Browser-worker prototype with a deterministic mock model.
- Shared persistent virtual workspace, selected just-bash commands, and file import/export.
- Parallel conversations, steering at tool boundaries, cancellation, and explicit recovery of uncertain calls.
- Trusted JavaScript plugin installation, optional tool replacement, explicit code updates, and cached native skills.
- HTTP MCP transport and sandboxed MCP Apps with app/model tool visibility.
- Durable background tasks, bounded goals, interval/event jobs, file monitors, and push wake events.
- Local SKILL.md discovery and a Charms plugin with native skill sync and workspace replacements.
- Charms-styled responsive UI with saved System/Light/Dark appearance, accessible mobile navigation, and a one-shot local static launcher.

Official ChatGPT login remains pending to preserve mandatory launcher process exit. Live Charms access is unverified; the adapter is tested with protocol fixtures.
