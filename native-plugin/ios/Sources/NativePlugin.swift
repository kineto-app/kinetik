import SwiftRs
import Tauri
import UIKit
import Security
import WebKit
import AuthenticationServices

struct NativeArgs: Decodable {
    let key: String?
    let value: String?
    let active: Bool?
    let url: String?
}
class NativePlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
    private weak var webview: WKWebView?
    private var authSession: ASWebAuthenticationSession?
    private var authInvoke: Invoke?
    private var authID: UUID?

    override public func load(webview: WKWebView) {
        self.webview = webview
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // authOpen checks that this window is attached before starting.
        return webview?.window ?? ASPresentationAnchor()
    }

    private func cancelAuthentication() {
        let session = authSession
        let pending = authInvoke
        authID = nil
        authSession = nil
        authInvoke = nil
        session?.cancel()
        pending?.reject("Sign-in cancelled.")
    }

    @objc public func authOpen(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(NativeArgs.self)
        guard let raw = args.url, let url = URL(string: raw),
              url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else {
            invoke.reject("Sign-in requires an HTTPS URL"); return
        }
        DispatchQueue.main.async {
            self.cancelAuthentication()
            guard self.webview?.window != nil else {
                invoke.reject("Open the app before signing in."); return
            }
            let id = UUID()
            self.authID = id
            self.authInvoke = invoke
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "kinetik") { callback, error in
                DispatchQueue.main.async {
                    guard self.authID == id else { return }
                    self.authID = nil
                    self.authSession = nil
                    self.authInvoke = nil
                    // This is only a dismissal signal. Rust validates the code/state
                    // received over loopback before TypeScript exchanges the code.
                    if error == nil, callback?.absoluteString == "kinetik://auth/complete" {
                        invoke.resolve([:])
                    } else {
                        invoke.reject("Sign-in cancelled.")
                    }
                }
            }
            session.presentationContextProvider = self
            self.authSession = session
            if !session.start() {
                self.cancelAuthentication()
            }
        }
    }

    @objc public func authCancel(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.cancelAuthentication()
            invoke.resolve([:])
        }
    }

    private func query(_ key: String) -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Bundle.main.bundleIdentifier ?? "app.kinetik.oss",
                kSecAttrAccount as String: key]
    }
    @objc public func secureGet(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(NativeArgs.self)
        guard let key = args.key, key.count <= 256 else { invoke.reject("Invalid credential key"); return }
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { invoke.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            invoke.reject("Could not read protected credentials. Unlock the device and try again."); return
        }
        invoke.resolve(["value": value])
    }
    @objc public func securePut(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(NativeArgs.self)
        guard let key = args.key, let value = args.value, key.count <= 256,
              value.utf8.count <= 262144 else { invoke.reject("Invalid credential record"); return }
        let q = query(key)
        let data = Data(value.utf8)
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var insert = q
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { invoke.reject("Could not save protected credentials"); return }
        invoke.resolve([:])
    }
    @objc public func background(_ invoke: Invoke) throws {
        // iOS uses durable resume-on-return; it does not pretend to run indefinitely.
        invoke.resolve([:])
    }
    @objc public func notify(_ invoke: Invoke) throws {
        // Not yet on iOS: resume-on-return shows the result when the app is opened.
        invoke.resolve(["value": "unsupported"])
    }
}
@_cdecl("init_plugin_native")
func initPlugin() -> Plugin { NativePlugin() }
