package com.vivek.remotesupport

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.UUID

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var deviceCode: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(Constants.PREFS_NAME, MODE_PRIVATE)
        deviceCode = prefs.getString(Constants.PREF_DEVICE_CODE, null) ?: run {
            val fresh = UUID.randomUUID().toString().take(8).uppercase()
            prefs.edit().putString(Constants.PREF_DEVICE_CODE, fresh).apply()
            fresh
        }

        findViewById<android.widget.TextView>(R.id.deviceCodeText).text =
            getString(R.string.device_id_label, deviceCode)

        requestNotificationPermissionIfNeeded()
        requestCameraPermissionIfNeeded()
        registerAndCollectInfo()

        findViewById<android.widget.Button>(R.id.getPairingCodeBtn).setOnClickListener {
            ApiClient.requestPairingCode(deviceCode) { code ->
                runOnUiThread {
                    if (code != null) {
                        findViewById<android.widget.TextView>(R.id.pairingCodeText).text =
                            getString(R.string.pairing_code_label, code)
                    } else {
                        Toast.makeText(this, R.string.pairing_code_failed, Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }

        findViewById<android.widget.Button>(R.id.enableAccessibilityBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        val enableBtn = findViewById<android.widget.Button>(R.id.goOnlineBtn)
        updateEnableButtonLabel(enableBtn)
        enableBtn.setOnClickListener {
            val enabled = prefs.getBoolean(Constants.PREF_LISTENING_ENABLED, false)
            if (enabled) {
                stopService(Intent(this, ListeningService::class.java))
                prefs.edit().putBoolean(Constants.PREF_LISTENING_ENABLED, false).apply()
            } else {
                startListening()
            }
            updateEnableButtonLabel(enableBtn)
        }
    }

    override fun onResume() {
        super.onResume()
        // Re-check on every return to this screen (e.g. coming back from
        // the system Accessibility settings) so setup completion is
        // detected without the user needing to tap anything else.
        maybeAutoEnable()
        updateEnableButtonLabel(findViewById(R.id.goOnlineBtn))
        updateStatusText()
    }

    /**
     * Per spec: once every required piece of setup is in place -
     * notification permission granted, accessibility service enabled,
     * device successfully registered - start listening automatically.
     * There is still a manual toggle (required by Android's own
     * restriction that a foreground service generally needs a direct
     * user interaction or an existing exemption to start), but the
     * user is never required to press it if they complete setup by
     * turning on the accessibility service last.
     */
    private fun maybeAutoEnable() {
        val alreadyEnabled = prefs.getBoolean(Constants.PREF_LISTENING_ENABLED, false)
        if (alreadyEnabled) return

        val notifOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val accessibilityOk = isAccessibilityServiceEnabled()

        if (notifOk && accessibilityOk) {
            startListening()
        }
    }

    private fun startListening() {
        ContextCompat.startForegroundService(this, Intent(this, ListeningService::class.java))
        prefs.edit().putBoolean(Constants.PREF_LISTENING_ENABLED, true).apply()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expected = "$packageName/${RemoteControlAccessibilityService::class.java.canonicalName}"
        val enabledServices = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabledServices)
        while (splitter.hasNext()) {
            if (splitter.next().equals(expected, ignoreCase = true)) return true
        }
        return false
    }

    private fun registerAndCollectInfo() {
        val info = DeviceInfoCollector.collect(applicationContext)
        ApiClient.registerDevice(deviceCode, DeviceInfoCollector.modelName(), DeviceInfoCollector.androidVersion(), info) { ok ->
            runOnUiThread { updateStatusText(ok) }
        }
    }

    private fun updateStatusText(registeredOk: Boolean? = null) {
        val statusView = findViewById<android.widget.TextView>(R.id.statusText)
        val accessibilityOk = isAccessibilityServiceEnabled()
        val listening = prefs.getBoolean(Constants.PREF_LISTENING_ENABLED, false)
        val parts = mutableListOf<String>()
        if (registeredOk != null) {
            parts.add(if (registeredOk) getString(R.string.status_registered) else getString(R.string.status_register_failed))
        }
        parts.add(if (accessibilityOk) "Accessibility: on" else "Accessibility: off")
        parts.add(if (listening) "Remote support: active" else "Remote support: off")
        statusView.text = parts.joinToString("  •  ")
    }

    private fun updateEnableButtonLabel(btn: android.widget.Button) {
        val enabled = prefs.getBoolean(Constants.PREF_LISTENING_ENABLED, false)
        btn.text = getString(if (enabled) R.string.disable_remote_support else R.string.enable_remote_support)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            }
        }
    }

    private fun requestCameraPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 101)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // A notification-permission grant can complete setup by itself
        // if accessibility was already on.
        maybeAutoEnable()
        updateStatusText()
    }
}
