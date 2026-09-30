package app.kinetik.oss

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private val ipcExecutor = Executors.newSingleThreadExecutor()
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Do not fall back to HTML-injected initialization scripts: their source can
    // expose an invoke key to a document embedded in an untrusted widget.
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
        !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      webView.settings.javaScriptEnabled = false
      AlertDialog.Builder(this)
        .setTitle("Update Android System WebView")
        .setMessage("Kinetik needs a newer Android System WebView. Update it in the Play Store, then reopen Kinetik.")
        .setPositiveButton("Close") { _, _ -> finish() }
        .setCancelable(false).show()
      return
    }
    WebViewCompat.addWebMessageListener(webView, "kinetikIPC", setOf("https://tauri.localhost")) {
      view, message, origin, isMainFrame, _ ->
      if (isMainFrame && origin.toString() == "https://tauri.localhost") {
        val id = (view as RustWebView).id
        val url = view.url ?: origin.toString()
        // Like Android's JavascriptInterface, dispatch off the UI thread.
        // Synchronous mobile plugin calls may need that thread to return a result.
        message.data?.let { data -> ipcExecutor.execute { Rust.ipc(id, url, data) } }
      }
    }
  }

  override fun onDestroy() {
    ipcExecutor.shutdown()
    super.onDestroy()
  }
}
