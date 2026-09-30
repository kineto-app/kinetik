package app.kinetik.nativebridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/** User-started agent work only. No idle daemon, automatic boot, or invisible service. */
class WorkService: Service() {
    companion object {
        var onStopRequested: (() -> Unit)? = null
        @Volatile var lastHeartbeat = 0L
        private const val CHANNEL = "kinetik-work"
        private const val STOP = "app.kinetik.STOP_WORK"
    }
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val watchdog = object: Runnable {
        override fun run() {
            // A dead JS runtime must not leave an endless working notification.
            if (SystemClock.elapsedRealtime() - lastHeartbeat > 120000) { stopSelf(); return }
            if (wakeLock?.isHeld != true) wakeLock?.acquire(10 * 60 * 1000L)
            handler.postDelayed(this, 30000)
        }
    }
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Agent work", NotificationManager.IMPORTANCE_LOW))
        }
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kinetik:agent-work")
        handler.post(watchdog)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            onStopRequested?.invoke()
            stopSelf()
            return START_NOT_STICKY
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, WorkService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle("Kinetik is working")
            .setContentText("Your task is continuing in the background")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_delete, "Stop", stop).build()
        startForeground(47, notification)
        return START_NOT_STICKY
    }
    override fun onDestroy() {
        handler.removeCallbacks(watchdog)
        if (wakeLock?.isHeld == true) wakeLock?.release()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
