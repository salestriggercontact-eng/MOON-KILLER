package com.vivek.remotesupport

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class ConsentActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Constants.ACTION_RESPOND) return

        val requestId = intent.getStringExtra(Constants.EXTRA_REQUEST_ID) ?: return
        val approve = intent.getBooleanExtra(Constants.EXTRA_APPROVE, false)
        val type = intent.getStringExtra(Constants.EXTRA_REQUEST_TYPE)
        val signalingRoom = intent.getStringExtra(Constants.EXTRA_SIGNALING_ROOM)

        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(Constants.NOTIF_ID_REQUEST)

        ApiClient.respondToRequest(requestId, approve) { ok ->
            if (ok && approve && type == "session" && signalingRoom != null) {
                // Approving a session only unlocks the NEXT step: the
                // OS's own MediaProjection permission dialog. Screen
                // capture still cannot start without that second,
                // system-level consent.
                val launch = Intent(context, ScreenCaptureRequestActivity::class.java).apply {
                    putExtra(Constants.EXTRA_SIGNALING_ROOM, signalingRoom)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(launch)
            }
        }
    }
}
