package com.vivek.remotesupport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Restarts the (idle, polling-only) ListeningService after reboot -
 * but ONLY if the user had previously toggled "Enable Remote Support"
 * on in the app. A fresh install or a user who never enabled it stays
 * completely dormant after boot.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences(Constants.PREFS_NAME, Context.MODE_PRIVATE)
        val wasEnabled = prefs.getBoolean(Constants.PREF_LISTENING_ENABLED, false)
        if (wasEnabled) {
            ContextCompat.startForegroundService(context, Intent(context, ListeningService::class.java))
        }
    }
}
