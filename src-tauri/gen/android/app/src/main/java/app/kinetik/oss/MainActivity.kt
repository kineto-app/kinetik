package app.kinetik.oss

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private val ipcExecutor = Executors.newSingleThreadExecutor()
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge, the keyboard no longer resizes the window: end the content at its top so the
    // composer stays visible.
    val content = findViewById<View>(android.R.id.content)
    val ime = WindowInsetsCompat.Type.ime()
    var animating = false
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      if (!animating) view.setPadding(0, 0, 0, insets.getInsets(ime).bottom)
      insets
    }
    // Follow the keyboard frame by frame, so the composer slides with it instead of jumping.
    ViewCompat.setWindowInsetsAnimationCallback(
      content,
      object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onPrepare(animation: WindowInsetsAnimationCompat) {
          if (animation.typeMask and ime != 0) animating = true
        }
        override fun onProgress(
          insets: WindowInsetsCompat,
          running: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat {
          if (animating) content.setPadding(0, 0, 0, insets.getInsets(ime).bottom)
          return insets
        }
        override fun onEnd(animation: WindowInsetsAnimationCompat) {
          if (animation.typeMask and ime == 0) return
          animating = false
          ViewCompat.requestApplyInsets(content)
        }
      },
    )
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
