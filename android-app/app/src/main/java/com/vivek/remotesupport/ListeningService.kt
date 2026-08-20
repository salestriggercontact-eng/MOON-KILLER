package com.vivek.remotesupport

import android.app.*
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

/**
 * Runs the whole time the user has toggled "Enable Remote Support" on
 * (or after the app auto-enables it once setup is complete - see
 * MainActivity.maybeAutoEnable()). Shows a persistent, non-dismissible
 * notification the entire time.
 *
 * Two independent timers, per spec: heartbeat every 30s (device
 * online/offline status), pending-request poll every 4s (so consent
 * prompts show up promptly). A failed heartbeat or poll simply gets
 * retried on the next tick - no crash, no service death.
 */
class ListeningService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var deviceCode: String = ""
    private var currentPendingId: String? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            ApiClient.sendHeartbeat(deviceCode) { ok ->
                if (!ok) {
                    // Network loss: nothing to clean up here, the next
                    // tick will simply retry. Device will show
                    // "offline" server-side once lastSeenAt goes stale.
                }
            }
            handler.postDelayed(this, Constants.HEARTBEAT_INTERVAL_MS)
        }
    }

    private val pollRunnable = object : Runnable {
        override fun run() {
            ApiClient.checkPendingRequest(deviceCode) { pending ->
                if (pending != null) {
                    val id = pending.optString("id")
                    if (id != currentPendingId) {
                        currentPendingId = id
                        showRequestNotification(
                            requestId = id,
                            type = pending.optString("type"),
                            adminUsername = pending.optString("adminUsername"),
                            signalingRoom = pending.optString("signalingRoom", null)
                        )
                    }
                } else {
                    currentPendingId = null
                }
            }
            handler.postDelayed(this, Constants.PENDING_REQUEST_POLL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        val prefs = getSharedPreferences(Constants.PREFS_NAME, MODE_PRIVATE)
        deviceCode = prefs.getString(Constants.PREF_DEVICE_CODE, "") ?: ""

        startForeground(Constants.NOTIF_ID_STATUS, statusNotification())
        handler.post(heartbeatRunnable)
        handler.post(pollRunnable)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Guard against duplicate starts: onCreate already kicked off
        // both loops, so a second onStartCommand (e.g. from BootReceiver
        // racing a manual launch) must not spawn a second pair of them.
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun statusNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, Constants.CHANNEL_ID_STATUS)
            .setContentTitle(getString(R.string.notif_status_title))
            .setContentText(getString(R.string.notif_status_text))
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setOngoing(true)
            .setContentIntent(openApp)
            .build()
    }

    private fun showRequestNotification(requestId: String, type: String, adminUsername: String, signalingRoom: String?) {
        val title = if (type == "pairing")
            getString(R.string.notif_pairing_request_title, adminUsername)
        else
            getString(R.string.notif_session_request_title, adminUsername)

        val allowIntent = Intent(this, ConsentActionReceiver::class.java).apply {
            action = Constants.ACTION_RESPOND
            putExtra(Constants.EXTRA_REQUEST_ID, requestId)
            putExtra(Constants.EXTRA_APPROVE, true)
            putExtra(Constants.EXTRA_REQUEST_TYPE, type)
            putExtra(Constants.EXTRA_SIGNALING_ROOM, signalingRoom)
        }
        val denyIntent = Intent(this, ConsentActionReceiver::class.java).apply {
            action = Constants.ACTION_RESPOND
            putExtra(Constants.EXTRA_REQUEST_ID, requestId)
            putExtra(Constants.EXTRA_APPROVE, false)
            putExtra(Constants.EXTRA_REQUEST_TYPE, type)
        }

        val allowPending = PendingIntent.getBroadcast(
            this, requestId.hashCode(), allowIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val denyPending = PendingIntent.getBroadcast(
            this, requestId.hashCode() + 1, denyIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, Constants.CHANNEL_ID_REQUESTS)
            .setContentTitle(title)
            .setContentText(getString(R.string.notif_request_body))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .addAction(0, getString(R.string.allow), allowPending)
            .addAction(0, getString(R.string.deny), denyPending)
            .build()

        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(Constants.NOTIF_ID_REQUEST, notification)
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)

        nm.createNotificationChannel(
            NotificationChannel(Constants.CHANNEL_ID_STATUS, "Remote Support Status", NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(Constants.CHANNEL_ID_REQUESTS, "Connection Requests", NotificationManager.IMPORTANCE_HIGH)
        )
        nm.createNotificationChannel(
            NotificationChannel(Constants.CHANNEL_ID_ACTIVE_SESSION, "Active Remote Session", NotificationManager.IMPORTANCE_HIGH)
        )
    }
}
