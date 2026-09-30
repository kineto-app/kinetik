# Native apps

Kinetik shares its SolidJS interface and TypeScript runtime between the PWA and Tauri 2 apps. Native apps use native HTTP, a protected credential store, file pickers, and a loopback OAuth listener. The PWA retains its service-worker runtime and existing hosting configuration.

Native builds wait for the Tauri bridge before loading the application. A late bridge must not select the browser runtime. If initialization does not complete within ten seconds, startup reports an error; browser builds start without this wait.

Android is available for testing. iOS has passed simulator startup checks but still needs physical-device acceptance testing. Windows remains experimental: the current startup check opens browser preview mode instead of native onboarding. Its CI build and diagnostic checks continue to run but do not block web and Android releases.

Android uses a main-frame-only WebMessageListener for native IPC. The invoke key is installed only in the top frame; sandboxed widgets cannot invoke native commands. Android System WebView must support document-start scripts and WebMessageListener. Older WebViews show an update requirement instead of loading an unsafe fallback.

Native HTTP omits the synthetic WebView `Origin` by default. The HTTP plugin enables `unsafe-headers` so an empty `Origin` suppresses its automatic header; explicit caller origins remain supported. Local assets still use WebView fetch, and sandboxed widgets do not receive native transport. This prevents capability-authenticated uploads from being rejected by servers that do not allow the app's local origin.

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

For Windows, run `npm run desktop:build` on a Windows machine with the Tauri build prerequisites. For iOS, use a Mac with full Xcode and its command-line tools selected:

```sh
npm run tauri -- ios init --ci
npm run ios:build -- --debug --target aarch64-sim --no-sign
```

A physical iOS build needs an Apple development team and signing identity. Set `APPLE_DEVELOPMENT_TEAM`; use TestFlight before distributing a store release. Do not regenerate Android project files without reviewing the resulting manifest and signing changes.

The unsigned simulator build also needs an app identity before testing Keychain access. Native CI embeds simulator-only XML and DER entitlements in Mach-O sections and checks the launch screenshot for startup errors. Follow its `Prepare simulator Keychain identity` step when building with `--no-sign` locally. The script adds simulator-only linker settings directly to the generated Xcode project because Tauri filters the environment passed to Xcode. Do not apply iOS entitlements to the simulator executable’s macOS code signature or use the simulator identity for a physical-device release.

## Distribution configuration

Set `KINETIK_NATIVE_CONFIG` to a JSON file using the connection format in [deployment.md](deployment.md#connections-and-guided-setup). It is embedded at build time. Include only public service endpoints and UI configuration, never tokens, passwords, or private keys. Native ChatGPT authorization is configured by the native adapter. Charms remains optional.

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

## Authentication and storage

The built-in ChatGPT connection defaults to GPT-6.1 Sol with medium reasoning. The model pill above the composer lists the signed-in account's available models. A selection is saved with that account's local credentials and applies to the next model request, including after reopening or token renewal. Other models use their provider's default reasoning settings. Existing logins without an explicit choice migrate to GPT-6.1 Sol; an unavailable model is reported instead of silently replaced.

ChatGPT sign-in opens the system browser on Android and desktop. iOS uses `ASWebAuthenticationSession` to present system sign-in over the app, keeping the loopback listener in the foreground. The iOS sheet is implemented but still requires simulator and physical-device validation. A listener binds a random loopback port before opening the authorization page. The app validates the returned state, exchanges the code using PKCE, validates the ID token and granted scope, and returns through a token-free app link. Authorization codes and tokens never enter that app link. Cancelling closes the listener.

Android encrypts credentials using an Android Keystore key. iOS stores them in the device-only Keychain. Desktop stores a small encryption key in the OS credential store and encrypted records in app data. The Windows credential-size limit therefore does not limit OAuth responses. Login data is separate from workspace exports.

Workspace data remains in the app's local IndexedDB. Keep the app identifier and WebView origin stable across upgrades. Uninstalling the app, clearing app data, or losing OS storage can remove local data. Settings offers explicit workspace export/import. Exports contain chats, files, plugin code, and routines; treat them as private. Connection settings and stored credentials are excluded. Imported plugins are disabled and routines paused until reviewed. Imported widget snapshots can display their original content; run the provider tool again after reconnecting to restore live interaction.

The composer stages selected files locally and sends them to the active workspace with the message. Failed uploads keep the message and selected files for retry. Enter inserts a newline; the Send button submits.

Native apps also retain unsent text and the selected chat across process restarts. Browser tabs keep separate drafts for each tab.

## Background work

Android starts a foreground service while user work or sign-in is active. Its notification has a Stop action. A wake lock and heartbeat support the existing JavaScript runtime; an absent heartbeat stops the service. It is not an always-on daemon and does not start on device boot. OEM power restrictions, force stop, and process loss can interrupt work.

The same durable runtime journals tool calls and background jobs on every platform. On reopening, remote jobs with recovery support are recovered without launching them again. Interrupted local commands cannot resume mid-command; uncertain effects are shown for review rather than blindly repeated. iOS and web use resume-on-return, not continuous execution after suspension.

## Frontend updates

Native updates use `tauri-plugin-hot-update` with signed manifests, SHA-256 archive verification, a minimum native version, atomic activation, and startup rollback. The default source build disables this channel. A distributor enables it at native-build time:

```sh
KINETIK_UPDATE_URL=https://updates.example.com/manifest.json \
KINETIK_UPDATE_PUBLIC_KEY='RW...public-minisign-key...' \
KINETIK_SIGNING_PROPERTIES=/path/to/signing.properties \
npm run android:release
```

Generate a minisign keypair once and keep the private key outside Git. Build the frontend with the same public connection configuration as the installed app, then sign it:

```sh
npm run build:native
KINETIK_UPDATE_SIGNING_KEY=/path/to/frontend-update.key \
npm run package:native-update -- 0.1.2 0.1.1 https://updates.example.com/
```

Upload the three files from `release/frontend/0.1.2/` to the configured host. Publish the archive before its manifest and signature. Never reuse an update version for different bytes. Changing the native bridge, permissions, signing trust, or platform capabilities requires a new native build. Downloadable code must also comply with the relevant store's distribution rules.

Checks are passive. The user clicks Update to download and stage a bundle, then closes and reopens the app to activate it. No live chat reload is forced. A new bundle must reach the UI-ready acknowledgement; after two consecutive launches without that acknowledgement, the next cold launch returns to the prior working bundle. The embedded assets remain the final fallback. An update feed outage leaves the installed app usable.

## Validation

`npm run check` covers the shared runtime and browser interface. `cargo test --manifest-path src-tauri/Cargo.toml` covers callback validation; `cargo test --manifest-path native-plugin/Cargo.toml` covers desktop encryption boundaries. Native CI builds supplement these checks and upload Android debug APKs, Windows installers, and an iOS simulator app. Windows CI launches the app and checks that the accessibility tree contains the ChatGPT sign-in action; iOS CI checks the launch screenshot for usable onboarding. Both checks upload their launch evidence. These artifacts do not prove real account login or physical-device lifecycle behavior.

Before distributing a native release, test a real subscription-backed response, Charms tools and skills, native file selection, widget isolation/fullscreen, screen lock, notification Stop, process-loss recovery, signed APK upgrades, and signed frontend update/rollback on devices. `tests/native/device-probe.ts` is an optional debug-WebView test fixture and is never bundled into the app.
