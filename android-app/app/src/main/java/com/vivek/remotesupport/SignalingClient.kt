package com.vivek.remotesupport

import android.os.Handler
import android.os.Looper
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONObject
import java.net.URI

class SignalingClient(
    private val roomId: String,
    private val listener: Listener
) {
    interface Listener {
        fun onOffer(offer: JSONObject)
        fun onIceCandidate(candidate: JSONObject)
        fun onPeerLeft()
        fun onStopSession()
        fun onOpen()
        fun onControlCommand(command: JSONObject) {}
    }

    private var ws: WebSocketClient? = null
    private val handler = Handler(Looper.getMainLooper())
    private var closedIntentionally = false
    private var reconnectAttempt = 0
    private val maxReconnectDelayMs = 15_000L

    fun connect() {
        closedIntentionally = false
        openSocket()
    }

    private fun openSocket() {
        ws = object : WebSocketClient(URI(Constants.SIGNALING_URL)) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                reconnectAttempt = 0
                send(JSONObject().apply {
                    put("type", "join")
                    put("roomId", roomId)
                    put("role", "phone")
                })
            }

            override fun onMessage(message: String?) {
                if (message == null) return
                val msg = try { JSONObject(message) } catch (e: Exception) { return }
                when (msg.optString("type")) {
                    "joined" -> listener.onOpen()
                    "offer" -> listener.onOffer(msg.optJSONObject("offer") ?: return)
                    "ice-candidate" -> listener.onIceCandidate(msg.optJSONObject("candidate") ?: return)
                    "peer-left" -> listener.onPeerLeft()
                    "stop-session" -> listener.onStopSession()
                    "control-command" -> listener.onControlCommand(msg.optJSONObject("command") ?: return)
                }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) {
                if (!closedIntentionally) scheduleReconnect()
            }

            override fun onError(ex: Exception?) {
                // onClose will follow and trigger the reconnect path
            }
        }
        ws?.connect()
    }

    private fun scheduleReconnect() {
        reconnectAttempt++
        val delay = minOf(1000L * (1 shl minOf(reconnectAttempt, 5)), maxReconnectDelayMs)
        handler.postDelayed({
            if (!closedIntentionally) openSocket()
        }, delay)
    }

    fun send(json: JSONObject) {
        if (ws?.isOpen == true) ws?.send(json.toString())
    }

    fun sendAnswer(answer: JSONObject) {
        send(JSONObject().apply { put("type", "answer"); put("answer", answer) })
    }

    fun sendIceCandidate(candidate: JSONObject) {
        send(JSONObject().apply { put("type", "ice-candidate"); put("candidate", candidate) })
    }

    fun close() {
        closedIntentionally = true
        handler.removeCallbacksAndMessages(null)
        ws?.close()
    }
}
