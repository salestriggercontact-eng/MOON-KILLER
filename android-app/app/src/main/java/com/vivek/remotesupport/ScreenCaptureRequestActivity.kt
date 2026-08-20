package com.vivek.remotesupport

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.core.content.ContextCompat

class ScreenCaptureRequestActivity : Activity() {

    private lateinit var signalingRoom: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        signalingRoom = intent.getStringExtra(Constants.EXTRA_SIGNALING_ROOM) ?: run {
            finish(); return
        }

        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mgr.createScreenCaptureIntent(), REQ_CODE)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CODE && resultCode == RESULT_OK && data != null) {
            val svcIntent = Intent(this, ScreenCaptureService::class.java).apply {
                putExtra("resultCode", resultCode)
                putExtra("data", data)
                putExtra(Constants.EXTRA_SIGNALING_ROOM, signalingRoom)
            }
            ContextCompat.startForegroundService(this, svcIntent)
        }
        // If the user declined the system dialog, nothing starts - session
        // simply never becomes active. Nothing to clean up.
        finish()
    }

    companion object {
        private const val REQ_CODE = 4001
    }
}
