# Changelog

## Unreleased

- Add a hidden custom OpenAI-compatible model (Chat Completions) under Settings → ChatGPT → Advanced; a chat can move between it and ChatGPT. Run several read-only tools at once, and hand reading tasks to a read-only helper agent (`delegate`). Try ChatGPT's own compaction before the local summary.

- Show a live reasoning summary while the model thinks and the step number in the activity line. Push streamed text, reasoning and progress to the open window as events instead of reloading all state per word. Store model input in append-only segments so a step saves only what it added.

- Send attached photos to the model as images. Queue a message to run after the current work. Let the agent ask a question with answer buttons, ask for approval before an MCP action marked destructive, and propose memory you confirm; memory is editable in Settings and read by every chat. Notify on finished work or a question while the app is in the background (web and Android).

- Show token usage per reply; summarise earlier messages automatically near the context limit, on `/compact`, and once after a context overflow. Return errors from calls that changed nothing to the agent instead of stopping. Raise the step limit to 60 with a guard against repeated identical calls.

- Rebuild Settings as an inset grouped list: a ChatGPT account row on top, Appearance as an in-row Light / Dark / Auto switch, and Export / Import in the data row. Connections become a page inside Settings with one page per service (status, version, Update, Turn on or off, Disconnect, Advanced) and an Add a connection page, replacing the separate connections dialog and the Manage / Disconnect buttons. The sidebar Connections button opens that page once setup is complete instead of the guided setup's last step.

- Show activity between narration as one quiet line in plain words ("Read 2 files, ran a command · 1 fixed") that opens into a flat, compact list of steps with kind icons and a status word only when it matters.

- Open activity steps as an inset submenu with tool, where it ran, and Input / Result as highlighted JSON with Copy, instead of a separate technical-details link. A group with a single step opens straight into its details.

- Format replies while they stream, with no jump when the final reply lands. Make the latest-message control a round arrow button. Show recent chats with a colour dot and age, and move New chat with its icon to the bottom of the sidebar.

- Choose a reasoning level for the current ChatGPT model with a Faster ↔ Smarter slider in the composer's model panel. Add several files at once from the file picker on web and Android. Saved widgets keep working after their plugin updates, so their images load again. Widgets have no host border, and the phone model sheet blocks taps on the chat behind it.

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
