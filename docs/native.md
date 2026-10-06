# Native apps

Kinetik shares its SolidJS interface and TypeScript runtime between the PWA and Tauri 2 apps. Native apps use native HTTP, a protected credential store, file pickers, and a loopback OAuth listener. The PWA retains its service-worker runtime and existing hosting configuration.

Android is available for testing. iOS has passed simulator startup checks but still needs physical-device acceptance testing. Windows remains experimental while native startup and device/account validation are in progress. Its CI build and diagnostic checks continue to run but do not block web and Android releases.

Android uses a main-frame-only WebMessageListener for native IPC. The invoke key is installed only in the top frame; sandboxed widgets cannot invoke native commands. Android System WebView must support document-start scripts and WebMessageListener. Older WebViews show an update requirement instead of loading an unsafe fallback.

Native HTTP omits the synthetic WebView `Origin` by default. The HTTP plugin enables `unsafe-headers` so an empty `Origin` suppresses its automatic header; explicit caller origins remain supported. Local assets still use WebView fetch, and sandboxed widgets do not receive native transport. This prevents capability-authenticated uploads from being rejected by servers that do not allow the app's local origin.

Windows Tauri IPC uses the virtual `ipc.localhost` host. Those requests also retain WebView fetch unchanged; routing them through native HTTP would recursively invoke the HTTP plugin and stall startup.

## Build

Install Node.js 22.12+, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the target platform. Android requires Java 21, Android SDK platform `platforms;android-37.0`, build tools 37.0.0, and NDK 28.2.13676358. Set `ANDROID_HOME` and `NDK_HOME`. Generated Android sources are committed so signing and manifest settings remain consistent.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run build:native
npm run android:build -- --debug --target aarch64 --apk
```

The debug package is `app.kinetik.oss.debug`. Release uses `app.kinetik.oss`; both can coexist. Debug builds contain Rust symbols and are much larger than release APKs.

For Windows, run `npm run desktop:build` on a Windows machine with the Tauri build prerequisites.

### iOS Simulator

No iPhone or Apple developer account is needed. On a Mac with Apple silicon:

1. Install Xcode from the App Store, open it once, accept the license, and add the iOS platform when it offers (or later in **Xcode → Settings → Components**).
2. Point the command-line tools at Xcode, add the Rust simulator target, and install CocoaPods:

   ```sh
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   rustup target add aarch64-apple-ios-sim
   brew install cocoapods
   ```

3. Build, install and open the app on an iPhone simulator:

   ```sh
   npm ci
   npm run ios:simulator
   ```

Run the last command again after pulling changes. It reuses the booted simulator and keeps the app's data. The build uses `native.config.json`; set `KINETIK_NATIVE_CONFIG` to build with your own connection settings (see [Distribution configuration](#distribution-configuration)). To start from a clean project, delete `src-tauri/gen/apple`. The CI also uploads each unsigned simulator build as the `ios-simulator` artifact, which installs with `xcrun simctl install booted Kinetik.app`.

An unsigned simulator build needs an app identity for Keychain access. `scripts/prepare-ios-simulator.sh`, used locally and by CI, embeds simulator-only XML and DER entitlements in Mach-O sections and adds simulator-only linker settings directly to the generated Xcode project, because Tauri filters the environment passed to Xcode. Do not apply iOS entitlements to the simulator executable’s macOS code signature or use the simulator identity for a physical-device release. CI also checks the launch screenshot for startup errors.

### iOS devices

A physical iOS build needs an Apple development team and signing identity. Set `APPLE_DEVELOPMENT_TEAM`; use TestFlight before distributing a store release. Do not regenerate Android project files without reviewing the resulting manifest and signing changes.

## Distribution configuration

Native builds embed a connection preset at build time. The same file carries the optional [`app` section](deployment.md#app-details): privacy policy, account page, support address, service name and sign-in client name. `native.config.json` is empty by default; set `KINETIK_NATIVE_CONFIG` to a JSON file in the connection format of [deployment.md](deployment.md#connections-and-guided-setup) to ship connections with your build. With a Charms preset, Kinetik installs the bundled Charms plugin on first launch, ready to sign in; `native.config.example.json` shows the shape with placeholder endpoints. Include only public service endpoints and UI configuration, never tokens, passwords, or private keys. Native ChatGPT authorization is configured by the native adapter.

To create a signed Android APK, keep a stable keystore and a private properties file outside the repository:

```properties
storeFile=/absolute/path/to/android-release.p12
storePassword=your-keystore-password
keyAlias=kinetik
keyPassword=your-key-password
```

```sh
KINETIK_SIGNING_PROPERTIES=/absolute/path/to/signing.properties npm run android:release
```

The default target is ARM64. `KINETIK_ANDROID_TARGET` selects another Tauri Android target. The APK is written beneath `src-tauri/gen/android/app/build/outputs/apk/`. Back up the keystore, passwords, and frontend signing key securely. Losing the Android key prevents updating an existing sideloaded installation. Increment the app version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` for each native release. Keep the application identifier unchanged.

## Platform differences

Features are shared; where a platform truly differs, the app reads a capability rather than the platform name (`src/platform/environment.ts`):

| Capability                       | Web | iOS | Android | Desktop |
| -------------------------------- | --- | --- | ------- | ------- |
| Add plugins from a link          | Yes | No  | Yes     | Yes     |
| Routines run only while open     | Yes | Yes | No      | No      |
| Work continues after leaving     | No  | No  | Yes     | No      |
| Notifications when work finishes | Yes | No  | Yes     | No      |

A native app that cannot tell its operating system (an older app shell, where an iPad can look like a Mac) gets the most restrictive column: plugins from a link do not run (they stay turned on for when the app can tell), no notifications, and routines only while open.

On iOS, only plugins that come with the app run, such as the bundled Charms adapter for a configured connection; its skills load as usual. **Add a connection** is hidden, plugins imported from another device cannot be turned on or updated there, and plugins added from a link before this rule are turned off at startup and left out of saved chats and jobs. Native apps report their operating system to the configured connection in the `X-Client-Platform` header. Android and desktop processes keep running while the app is in the background, so their routines keep the existing wording.

## Authentication and storage

The built-in ChatGPT connection defaults to GPT-6.1 Sol with medium reasoning. The model button inside the composer lists the signed-in account's available models and the reasoning levels the chosen model supports. Both choices are saved with that account's local credentials and apply to the next model request, including after reopening or token renewal. Switching models resets reasoning to that model's default; other models use their provider's default until a level is chosen. Existing logins without an explicit choice migrate to GPT-6.1 Sol; an unavailable model is reported instead of silently replaced.

ChatGPT sign-in opens the system browser on Android and desktop. iOS uses `ASWebAuthenticationSession` to present system sign-in over the app, keeping the loopback listener in the foreground. The iOS sheet is implemented but still requires simulator and physical-device validation. A listener binds a random loopback port before opening the authorization page. The app validates the returned state, exchanges the code using PKCE, validates the ID token and granted scope, and returns through a token-free app link. Authorization codes and tokens never enter that app link. Cancelling closes the listener.

Android encrypts credentials using an Android Keystore key. iOS stores them in the device-only Keychain. Desktop stores a small encryption key in the OS credential store and encrypted records in app data. The Windows credential-size limit therefore does not limit OAuth responses. Login data is separate from workspace exports.

Workspace data remains in the app's local IndexedDB. Keep the app identifier and WebView origin stable across upgrades. Uninstalling the app, clearing app data, or losing OS storage can remove local data. Settings offers explicit workspace export/import. Exports contain chats, files, plugin code, and routines; treat them as private. Connection settings and stored credentials are excluded. Imported plugins are disabled and routines paused until reviewed. Imported widget snapshots can display their original content; run the provider tool again after reconnecting to restore live interaction.

The composer stages selected files locally and sends them to the active workspace with the message. Failed uploads keep the message and selected files for retry. Enter inserts a newline; the Send button submits.

Native apps also retain unsent text and the selected chat across process restarts. Browser tabs keep separate drafts for each tab.

## Background work

Android starts a foreground service while user work or sign-in is active. Its notification has a Stop action. A wake lock and heartbeat support the existing JavaScript runtime; an absent heartbeat stops the service. It is not an always-on daemon and does not start on device boot. OEM power restrictions, force stop, and process loss can interrupt work.

The same durable runtime journals tool calls and background jobs on every platform. On reopening, remote jobs with recovery support are recovered without launching them again. Interrupted local commands cannot resume mid-command; uncertain effects are shown for review rather than blindly repeated. iOS and web use resume-on-return, not continuous execution after suspension.

## Frontend updates

The built-in updater silently stages signed web bundles for the next cold start. It is disabled by default on every platform. A distributor enables it at native-build time by setting `KINETIK_UPDATES_CONFIG` to a JSON file:

```json
{
  "manifestUrl": "https://updates.example.com/manifest.json",
  "channel": "everyone",
  "publicKeys": ["<active minisign public key>", "<spare minisign public key>"],
  "healthUrl": "https://updates.example.com/health"
}
```

Use the base64 public-key lines from two distinct minisign keypairs. The placeholders above are not keys. `healthUrl` is optional. Configuration is validated and embedded by the Rust build; invalid configuration fails the build. Keep private keys outside the repository. The manifest, signature, archive and health endpoints require HTTPS; redirects, URL credentials and fragments are rejected. A distributor can rotate signing from the active key to the spare without a shell release; replacing the trusted key set requires a native release.

```sh
KINETIK_UPDATES_CONFIG=/path/to/updates.json npm run android:release
```

Build `dist-native` with the same connection configuration as the installed app, then package it:

```sh
npm run build:native
npm run package:native-update -- 0.2.0 0.1.15 1 https://updates.example.com/
```

The command writes `release/frontend/0.2.0/bundle-0.2.0.tar.gz` and `release.json`, and prints the unsigned release entry. Arguments are bundle version, minimum native shell version, workspace data format, and archive base URL. Archives contain the contents of `dist-native` at their root. Only regular files and directories are accepted; links, path traversal, duplicate files, and archives without `index.html` are rejected. Limits are 64 MiB compressed, 256 MiB extracted and 10,000 entries. The embedded workspace data format is currently `1`.

Each channel has one manifest with this shape. Replace the archive hash and size with the packager's output, and use a current validity period:

```json
{
  "schema": 1,
  "channel": "everyone",
  "createdAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2026-11-01T00:00:00Z",
  "releases": [
    {
      "version": "0.2.0",
      "minShellVersion": "0.1.15",
      "dataFormat": 1,
      "urgent": false,
      "rollout": 100,
      "archive": {
        "url": "https://updates.example.com/bundle-0.2.0.tar.gz",
        "sha256": "<SHA-256 from release.json>",
        "size": 12345
      }
    }
  ],
  "revoked": []
}
```

Signing and publishing belong to the distributor. Sign the exact UTF-8 manifest bytes with minisign and serve the detached signature at the manifest path plus `.minisig`, such as `manifest.json.minisig`. Publish archives before the manifest and signature. Never reuse a version for different bytes. The app verifies the signature with either trusted key before parsing the manifest, then rejects malformed, expired, future-dated, or wrong-channel manifests.

A release must exceed both the active version and a persistent version watermark, support the current native shell, and not be revoked. The updater chooses the highest eligible version whose data format is not older than the live workspace. It persists the newest accepted manifest `createdAt` per channel, rejects older feeds, and retains every revocation even if a later manifest omits it. Rollout uses the entire SHA-256 digest of the installation UUID followed immediately by the version string, interpreted as a big-endian integer modulo 100. That bucket must be below `rollout`. The UUID is generated once and kept in app data; neither rollback nor opting out of reports changes it.

Checks run after local UI readiness, on foreground, when connectivity returns, and every 15 minutes while visible. Downloads are bounded, checked against size and SHA-256, unpacked in a temporary directory, then renamed atomically. The running app never reloads. A small “Restart to update” pill appears for urgent updates or after a staged release has waited more than three days; close and reopen the app to apply it. There is no native Update button. The browser retains its separate service-worker update flow.

The native shell selects assets before creating the webview, using Tauri's [`Context::set_assets`](https://docs.rs/tauri/latest/tauri/struct.Context.html#method.set_assets). The webview origin and local storage stay unchanged. The main screen must paint and the local chat list must load before JavaScript calls `updates_ready`. Two consecutive starts without that acknowledgement cause rollback on the following cold start. A revoked active version also rolls back on the next cold start. The fallback is a non-revoked previous healthy or embedded bundle whose data format matches the live workspace or its exact saved snapshot. Bundle identity includes its source, version and data format; an embedded bundle never substitutes for downloaded assets solely because versions match. If no compatible fallback exists, the embedded recovery screen runs with the workspace closed. Revoked or repeatedly failing code stops executing. Recovery checks the signed feed immediately, every minute while visible, on foreground, and when connectivity returns. It stages the newest eligible non-revoked release with exactly the live workspace’s data format, then prompts the user to close and reopen Kinetik. It never exports, restores or migrates workspace data during this wait. On every cold start, an unfinished restore selects the newest available non-revoked bundle with the snapshot’s target data format, including a new native shell or a signed downloaded replacement. The selected code restores the original snapshot before runtime initialization. If compatible code is unavailable, recovery keeps checking for a replacement in that target format. Selecting replacement code preserves the pending snapshot and the outgoing-data backup, including after a native upgrade removes the original embedded target. Embedded, previous good, current and staged bundles are retained. The first healthy start of a new bundle shows “Kinetik was updated”. Native bridge, permission, signing trust and platform changes still require a native release. Desktop full-app updates use a separate updater.

Before activating a release with a higher `dataFormat`, the old code saves the existing workspace export to `<app data>/updates/snapshots/<from-version>.json`. Export waits until work is idle; activation stays blocked until it succeeds. Rollback restores that snapshot before runtime initialization, then deletes it. Restore follows workspace import semantics: credentials stay on the device, imported plugins are disabled, and routines are paused. Every workspace mutation durably invalidates snapshot readiness before writing. Export and acknowledgement share the same lock as writes, so activation uses a snapshot that includes all work made before the switch. A later write blocks activation again until a fresh idle export succeeds. Before restoring, the app keeps a strict, structured-clone copy of every outgoing IndexedDB record in a separate `kinetik-update-recovery-<id>` database. That copy preserves future schemas and remains available for recovery; retrying a restore does not overwrite it. Work made by the failed new bundle is in that recovery copy rather than the restored workspace. A snapshot is removed after three healthy starts of the new version. Further releases wait for that observation period to finish. Snapshots contain private workspace data and are never sent with reports.

Desktop builds use Tauri’s single-instance plugin to focus the existing window; an exclusive directory lock also guards updater and workspace ownership. State is committed to two generation-numbered copies before recovery files are pruned. Renames sync their parent directories on Unix and use write-through moves on Windows. If a state file is damaged, the shell quarantines its bytes, recovers metadata from the last valid copy, and opens the embedded recovery screen without opening the workspace. Reopening resumes compatible code after repair. Builds with updates disabled also repair a valid backup under the ownership lock, preserving consent and watermarks before showing the one-time recovery message. If state cannot be trusted or saved, recovery stays available and data is kept.

If `healthUrl` is configured, Settings offers “Send anonymous update reports”, enabled by default. Reports contain `{ installId, platform, shellVersion, bundleVersion, channel, event, at }`, plus `runningBundleVersion` for `rolled_back`. For a new rollback report, `bundleVersion` names the abandoned bundle that failed or was revoked, and `runningBundleVersion` names the selected fallback. Other events omit `runningBundleVersion`. Older queued reports remain readable and are sent unchanged; rollback reports without the new field retain the older destination-only meaning of `bundleVersion`. Events are `started`, `failed_start`, `rolled_back`, `first_use_ok` and `first_use_error`. First use means opening a chat or submitting a message after an update; model and network failures are not update failures. Reports are stored locally and capped at 100 queued events. Each flush sends due reports in queue order until the queue is empty or the first request fails. A failed report keeps the existing exponential backoff; later reports wait behind it, including after restart. Each successful removal or retry schedule is committed before continuing. Opting out clears queued reports. A request already sent may finish. No chats, credentials, or exception text are included. Manifest outages and report failures do not block the UI.

The initial switch from a shell without this module requires a native release. Downloaded code must comply with the target store's distribution rules. Device acceptance testing is still required before distributing an enabled build.

## Validation

`npm run check` covers the shared runtime and browser interface. `cargo test --manifest-path src-tauri/Cargo.toml` covers callback validation and updater signatures, eligibility, extraction, rollback, snapshots, health gating and a signed loopback feed. Tests generate fresh signing keys in memory and require no signing CLI or committed keys. The loopback integration test injects an HTTP client only in test code; production enforces HTTPS. `cargo test --manifest-path native-plugin/Cargo.toml` covers desktop encryption boundaries. Native CI builds supplement these checks and upload Android debug APKs, Windows installers, and an iOS simulator app. Windows CI launches the app and checks that the accessibility tree contains the ChatGPT sign-in action; iOS CI checks the launch screenshot for usable onboarding. Both checks upload their launch evidence. These artifacts do not prove real account login or physical-device lifecycle behavior.

Before distributing a native release, test a real subscription-backed response, Charms tools and skills, native file selection, widget isolation/fullscreen, screen lock, notification Stop, process-loss recovery, signed APK upgrades, and signed frontend update/rollback on devices. `tests/native/device-probe.ts` is an optional debug-WebView test fixture and is never bundled into the app.
