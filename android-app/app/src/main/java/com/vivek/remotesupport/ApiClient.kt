package com.vivek.remotesupport

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.IOException

object ApiClient {
    private val client = OkHttpClient()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun post(path: String, body: JSONObject, cb: (JSONObject?, IOException?) -> Unit) {
        val req = Request.Builder()
            .url("${Constants.BACKEND_URL}$path")
            .post(RequestBody.create(JSON, body.toString()))
            .build()

        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = cb(null, e)
            override fun onResponse(call: Call, response: Response) {
                val text = response.body?.string() ?: "{}"
                try {
                    cb(JSONObject(text), null)
                } catch (e: Exception) {
                    cb(null, IOException("Bad response: $text"))
                }
            }
        })
    }

    private fun get(path: String, cb: (JSONObject?, IOException?) -> Unit) {
        val req = Request.Builder().url("${Constants.BACKEND_URL}$path").get().build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = cb(null, e)
            override fun onResponse(call: Call, response: Response) {
                val text = response.body?.string() ?: "{}"
                try {
                    cb(JSONObject(text), null)
                } catch (e: Exception) {
                    cb(null, IOException("Bad response: $text"))
                }
            }
        })
    }

    fun registerDevice(deviceCode: String, model: String, androidVersion: String, deviceInfo: JSONObject? = null, cb: (Boolean) -> Unit) {
        val body = JSONObject().apply {
            put("deviceCode", deviceCode)
            put("deviceModel", model)
            put("androidVersion", androidVersion)
            if (deviceInfo != null) put("deviceInfo", deviceInfo)
        }
        post("/api/devices/register", body) { res, err -> cb(err == null && res != null) }
    }

    fun sendHeartbeat(deviceCode: String, cb: (Boolean) -> Unit) {
        val body = JSONObject().apply { put("deviceCode", deviceCode) }
        post("/api/devices/heartbeat", body) { res, err -> cb(err == null && res != null) }
    }

    fun requestPairingCode(deviceCode: String, cb: (String?) -> Unit) {
        val body = JSONObject().apply { put("deviceCode", deviceCode) }
        post("/api/devices/pairing-code", body) { res, err ->
            cb(if (err == null && res != null) res.optString("pairingCode") else null)
        }
    }

    fun checkPendingRequest(deviceCode: String, cb: (JSONObject?) -> Unit) {
        get("/api/devices/pending-request?deviceCode=$deviceCode") { res, err ->
            if (err != null || res == null) return@get cb(null)
            val pending = res.optJSONObject("pending")
            cb(pending)
        }
    }

    fun respondToRequest(requestId: String, approve: Boolean, cb: (Boolean) -> Unit) {
        val body = JSONObject().apply { put("approve", approve) }
        post("/api/devices/pending-request/$requestId/respond", body) { res, err ->
            cb(err == null && res != null)
        }
    }

    /** Fire-and-forget audit report. Never carries typed text/PINs -
     *  only a fixed action name and, for control_action, a fixed
     *  command name (see ALLOWED_CONTROL_COMMANDS on the backend). */
    fun reportAuditEvent(deviceCode: String, action: String, success: Boolean, command: String? = null) {
        val body = JSONObject().apply {
            put("deviceCode", deviceCode)
            put("action", action)
            put("success", success)
            if (command != null) put("command", command)
        }
        post("/api/devices/audit-event", body) { _, _ -> } // best-effort, no retry
    }

    /** TEMPORARY - diagnostic-only, shows up in backend Render logs.
     *  Remove once the black-screen WebRTC issue is resolved. */
    fun debugLog(deviceCode: String, msg: String) {
        val body = JSONObject().apply {
            put("deviceCode", deviceCode)
            put("msg", msg)
        }
        post("/api/devices/debug-log", body) { _, _ -> }
    }
}
