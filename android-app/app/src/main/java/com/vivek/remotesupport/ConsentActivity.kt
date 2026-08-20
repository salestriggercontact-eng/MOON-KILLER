package com.vivek.remotesupport

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog

/**
 * Fallback consent screen. In practice most users respond via the
 * notification's Allow/Deny action buttons (ConsentActionReceiver),
 * but this gives the same choice if they tap the notification body.
 */
class ConsentActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val requestId = intent.getStringExtra(Constants.EXTRA_REQUEST_ID)
        val type = intent.getStringExtra(Constants.EXTRA_REQUEST_TYPE) ?: "session"
        val admin = intent.getStringExtra(Constants.EXTRA_ADMIN_USERNAME) ?: "Unknown admin"
        val signalingRoom = intent.getStringExtra(Constants.EXTRA_SIGNALING_ROOM)

        if (requestId == null) { finish(); return }

        val message = if (type == "pairing")
            "$admin wants to pair with this device for future support sessions."
        else
            "$admin wants to start a remote support session on this device right now."

        AlertDialog.Builder(this)
            .setTitle("Remote Support Request")
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("Allow") { _, _ ->
                ApiClient.respondToRequest(requestId, true) { ok ->
                    if (ok && type == "session" && signalingRoom != null) {
                        startActivity(android.content.Intent(this, ScreenCaptureRequestActivity::class.java).apply {
                            putExtra(Constants.EXTRA_SIGNALING_ROOM, signalingRoom)
                        })
                    }
                    finish()
                }
            }
            .setNegativeButton("Deny") { _, _ ->
                ApiClient.respondToRequest(requestId, false) { finish() }
            }
            .show()
    }
}
