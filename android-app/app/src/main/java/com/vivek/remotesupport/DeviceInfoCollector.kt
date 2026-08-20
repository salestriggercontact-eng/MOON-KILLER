package com.vivek.remotesupport

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import org.json.JSONObject

/**
 * Collects only device/hardware facts needed for support triage
 * (manufacturer, model, OS/SDK version, RAM, storage, battery/charging
 * state, this app's own version). Deliberately does NOT touch contacts,
 * location, installed-app lists, accounts, or any other personal data.
 */
object DeviceInfoCollector {

    fun modelName(): String = "${Build.MANUFACTURER} ${Build.MODEL}"

    fun androidVersion(): String = "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"

    fun collect(context: Context): JSONObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)

        val stat = StatFs(Environment.getDataDirectory().path)
        val totalStorage = stat.blockCountLong * stat.blockSizeLong
        val freeStorage = stat.availableBlocksLong * stat.blockSizeLong

        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val batteryPct = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        val isCharging = batteryManager?.isCharging ?: false

        val appVersion = try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            pInfo.versionName ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }

        return JSONObject().apply {
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("ramTotalBytes", memInfo.totalMem)
            put("ramAvailableBytes", memInfo.availMem)
            put("storageTotalBytes", totalStorage)
            put("storageFreeBytes", freeStorage)
            put("batteryPercent", batteryPct)
            put("isCharging", isCharging)
            put("appVersion", appVersion)
        }
    }
}
