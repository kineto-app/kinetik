package app.kinetik.nativebridge

import android.app.Activity
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class NativeArgs {
    var key: String? = null
    var value: String? = null
    var active: Boolean? = null
    var url: String? = null
}

@TauriPlugin(permissions = [Permission(strings = [android.Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class NativePlugin(private val activity: Activity): Plugin(activity) {
    private val preferences by lazy { activity.getSharedPreferences("kinetik-credentials", 0) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "kinetik-credentials-v1"
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Command
    fun secureGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(NativeArgs::class.java)
            val name = requireNotNull(args.key)
            require(name.length <= 256)
            val stored = preferences.getString(name, null)
            val result = JSObject()
            if (stored != null) {
                val bytes = Base64.decode(stored, Base64.NO_WRAP)
                require(bytes.size >= 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
                result.put("value", String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            }
            invoke.resolve(result)
        } catch (e: Exception) { invoke.reject("Could not read protected credentials. Unlock the device and try again.") }
    }
    @Command
    fun securePut(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(NativeArgs::class.java)
            val name = requireNotNull(args.key)
            val value = requireNotNull(args.value)
            require(name.length <= 256 && value.length <= 262144)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            val bytes = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            check(preferences.edit().putString(name, Base64.encodeToString(bytes, Base64.NO_WRAP)).commit())
            invoke.resolve(JSObject())
        } catch (e: Exception) { invoke.reject("Could not save protected credentials.") }
    }
    @Command
    fun fileInfo(invoke: Invoke) {
        try {
            val uri = android.net.Uri.parse(requireNotNull(invoke.parseArgs(NativeArgs::class.java).url))
            require(uri.scheme == "content")
            val info = JSObject()
            activity.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    info.put("name", cursor.getString(0))
                    if (!cursor.isNull(1)) info.put("size", cursor.getLong(1))
                }
            }
            invoke.resolve(JSObject().put("value", info.toString()))
        } catch (e: Exception) { invoke.reject("Could not read the selected file.") }
    }
    @Command
    fun background(invoke: Invoke) {
        val active = invoke.parseArgs(NativeArgs::class.java).active == true
        if (active && android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(activity, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            !preferences.getBoolean("notification-permission-requested", false)) {
            // Resolve before opening the authentication browser so it cannot cover
            // or cancel Android's notification permission dialog.
            requestPermissionForAlias("notifications", invoke, "backgroundPermission")
            return
        }
        startBackground(invoke)
    }
    @PermissionCallback
    fun backgroundPermission(invoke: Invoke) {
        preferences.edit().putBoolean("notification-permission-requested", true).apply()
        startBackground(invoke)
    }
    private fun startBackground(invoke: Invoke) {
        try {
            val active = invoke.parseArgs(NativeArgs::class.java).active == true
            WorkService.onStopRequested = { trigger("background-stop", JSObject()) }
            if (active) {
                WorkService.lastHeartbeat = android.os.SystemClock.elapsedRealtime()
                ContextCompat.startForegroundService(activity, Intent(activity, WorkService::class.java))
            } else activity.stopService(Intent(activity, WorkService::class.java))
            invoke.resolve(JSObject())
        } catch (e: Exception) { invoke.reject("Android could not start background work. Keep Kinetik open while it works.") }
    }
}
