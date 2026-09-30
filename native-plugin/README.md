# Kinetik native bridge

Provides protected credential storage, Android foreground-work notifications, and Android content-URI metadata. The TypeScript callers live in `src/platform/` in the parent application. See [native build and release instructions](../docs/native.md).

Android uses Keystore-backed AES-GCM. iOS uses the device-only Keychain. Desktop stores an encryption key in the OS credential store and encrypted records in app data. No platform logs credential values.
