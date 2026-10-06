import SwiftRs
import Tauri
import UIKit
import Security
import WebKit
import AuthenticationServices
import BackgroundTasks
import UserNotifications

struct NativeArgs: Decodable {
    let key: String?
    let value: String?
    let active: Bool?
    let url: String?
    /// The work in progress includes a run the user started (not a routine or recovered work).
    let started: Bool?
}
class NativePlugin: Plugin, ASWebAuthenticationPresentationContextProviding, UNUserNotificationCenterDelegate {
    private weak var webview: WKWebView?
    private var authSession: ASWebAuthenticationSession?
    private var authInvoke: Invoke?
    private var authID: UUID?

    override init() {
        super.init()
        // Set before launch finishes, so a tap that launched the app is delivered too.
        UNUserNotificationCenter.current().delegate = self
    }

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
    // MARK: Work that continues after the user leaves

    /// While work runs, JavaScript calls this with active=true about every 15 seconds, and with
    /// active=false when it ends. For a run the user started (started=true), iOS 26 and later can
    /// keep the app running for a while after the user leaves through a continued-processing task;
    /// the system shows its progress and may end it at any time. JavaScript sends started=true only
    /// where this is enabled. Otherwise, and on earlier versions, work resumes on return.
    @objc public func background(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(NativeArgs.self)
        let active = args.active == true
        let started = args.started == true
        DispatchQueue.main.async {
            #if compiler(>=6.2)
            if #available(iOS 26.0, *) {
                if active { self.continueWork(started: started) } else { self.endWork() }
                invoke.resolve(["value": "continues"])
                return
            }
            #else
            NSLog("Kinetik: built without the iOS 26 SDK; work resumes when the app returns")
            #endif
            invoke.resolve(["value": "resume"])
        }
    }

    private var workTask: BGTask?
    /// One request per stretch of work: a declined or ended request is not retried until it ends.
    private var workRequested = false
    private var lastBeat = Date()
    private var beats: Int64 = 0
    private var watchdog: Timer?

    #if compiler(>=6.2)
    @available(iOS 26.0, *)
    private func continueWork(started: Bool) {
        lastBeat = Date()
        if let task = workTask as? BGContinuedProcessingTask {
            // The system ends tasks whose progress stalls; each heartbeat is real progress
            // of the JavaScript runtime, shown as a bar that keeps moving.
            beats += 1
            task.progress.totalUnitCount = beats + 1
            task.progress.completedUnitCount = beats
            return
        }
        // Requests are accepted only from the foreground, and only for runs the user started.
        guard started, !workRequested, UIApplication.shared.applicationState == .active,
              let bundle = Bundle.main.bundleIdentifier else { return }
        workRequested = true
        // Registration takes the full identifier; Info.plist permits `<bundle id>.run.*`.
        let identifier = bundle + ".run." + UUID().uuidString
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
            guard let self, self.workRequested, self.workTask == nil,
                  let work = task as? BGContinuedProcessingTask else {
                task.setTaskCompleted(success: false); return
            }
            // The user cancelled it, or the system needs the time back: stop the work, like
            // Android's Stop action.
            work.expirationHandler = { [weak self] in
                self?.dropWork()
                self?.trigger("background-stop", data: [:])
            }
            self.beats = 0
            work.progress.totalUnitCount = 1
            self.workTask = work
            self.watchdog?.invalidate()
            // A suspended or stopped JavaScript runtime must not leave the task running.
            self.watchdog = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                guard let self, Date().timeIntervalSince(self.lastBeat) > 120 else { return }
                self.dropWork()
            }
        }
        guard registered else { return }
        let name = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName")
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName")) as? String ?? "Kinetik"
        let request = BGContinuedProcessingTaskRequest(
            identifier: identifier, title: "\(name) is working",
            subtitle: "Your task continues while you are away")
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("Kinetik: continuing work in the background is unavailable (%@)", String(describing: error))
        }
    }
    #endif

    private func dropWork() {
        watchdog?.invalidate()
        watchdog = nil
        let task = workTask
        workTask = nil
        task?.setTaskCompleted(success: false)
    }

    private func endWork() {
        workRequested = false
        watchdog?.invalidate()
        watchdog = nil
        let task = workTask
        workTask = nil
        task?.setTaskCompleted(success: true)
    }

    // MARK: Notifications

    /// active=true asks for permission; otherwise key is the title, value the text and url the chat
    /// a tap opens. JavaScript calls it only while the app is in the background.
    @objc public func notify(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(NativeArgs.self)
        let center = UNUserNotificationCenter.current()
        if args.active == true {
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                invoke.resolve(["value": granted ? "granted" : "denied"])
            }
            return
        }
        guard let title = args.key, let body = args.value else {
            invoke.reject("Invalid notification"); return
        }
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(200))
        content.body = String(body.prefix(1000))
        content.sound = .default
        if let chat = args.url, chat.count <= 128 { content.userInfo = ["chat": chat] }
        // One notification per chat; a newer one replaces it.
        let request = UNNotificationRequest(
            identifier: "chat:" + (args.url ?? UUID().uuidString), content: content, trigger: nil)
        center.add(request) { error in
            invoke.resolve(["value": error == nil ? "shown" : "unsupported"])
        }
    }

    /// A tap can arrive before the page listens (a cold start); it waits until the page asks.
    private var pendingChat: String?
    private var listening = false

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let chat = response.notification.request.content.userInfo["chat"] as? String {
            DispatchQueue.main.async {
                if self.listening { self.trigger("open-chat", data: ["id": chat]) } else { self.pendingChat = chat }
            }
        }
        completionHandler()
    }

    /// Called by the plugin once the page listens for open-chat.
    @objc public func openPendingChat(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.listening = true
            if let chat = self.pendingChat { self.trigger("open-chat", data: ["id": chat]) }
            self.pendingChat = nil
            invoke.resolve([:])
        }
    }
}
@_cdecl("init_plugin_native")
func initPlugin() -> Plugin { NativePlugin() }
