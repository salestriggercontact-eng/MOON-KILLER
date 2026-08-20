package com.vivek.remotesupport

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONObject
import java.net.URI

class SignalingClient(
    private val roomId: String,
    private val listener: Listener
) {
    companion object { private const val TAG = "RS_Signaling" }

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
        Log.d(TAG, "connect() called for room=$roomId url=${Constants.SIGNALING_URL}")
        closedIntentionally = false
        openSocket()
    }

    private fun openSocket() {
        ws = object : WebSocketClient(URI(Constants.SIGNALING_URL)) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                Log.d(TAG, "WebSocket open. Sending join as phone.")
                reconnectAttempt = 0
                send(JSONObject().apply {
                    put("type", "join")
                    put("roomId", roomId)
                    put("role", "phone")
                })
            }

            override fun onMessage(message: String?) {
                if (message == null) return
                Log.d(TAG, "Message received: $message")
                val msg = try { JSONObject(message) } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse message", e)
                    return
                }
                when (msg.optString("type")) {
                    "joined" -> { Log.d(TAG, "Joined room."); listener.onOpen() }
                    "offer" -> {
                        Log.d(TAG, "Offer message received, forwarding to listener.")
                        listener.onOffer(msg.optJSONObject("offer") ?: run {
                            Log.e(TAG, "Offer message missing 'offer' field"); return
                        })
                    }
                    "ice-candidate" -> listener.onIceCandidate(msg.optJSONObject("candidate") ?: return)
                    "peer-left" -> { Log.d(TAG, "Peer left."); listener.onPeerLeft() }
                    "stop-session" -> listener.onStopSession()
                    "control-command" -> listener.onControlCommand(msg.optJSONObject("command") ?: return)
                    else -> Log.w(TAG, "Unknown message type: ${msg.optString("type")}")
                }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) {
                Log.w(TAG, "WebSocket closed. code=$code reason=$reason remote=$remote closedIntentionally=$closedIntentionally")
                if (!closedIntentionally) scheduleReconnect()
            }

            override fun onError(ex: Exception?) {
                Log.e(TAG, "WebSocket error", ex)
                // onClose will follow and trigger the reconnect path
            }
        }
        ws?.connect()
    }

    private fun scheduleReconnect() {
        reconnectAttempt++
        val delay = minOf(1000L * (1 shl minOf(reconnectAttempt, 5)), maxReconnectDelayMs)
        Log.d(TAG, "Scheduling reconnect attempt #$reconnectAttempt in ${delay}ms")
        handler.postDelayed({
            if (!closedIntentionally) openSocket()
        }, delay)
    }

    fun send(json: JSONObject) {
        if (ws?.isOpen == true) {
            ws?.send(json.toString())
        } else {
            Log.w(TAG, "Tried to send while socket not open: $json")
        }
    }

    fun sendAnswer(answer: JSONObject) {
        Log.d(TAG, "Sending answer.")
        send(JSONObject().apply { put("type", "answer"); put("answer", answer) })
    }

    fun sendIceCandidate(candidate: JSONObject) {
        send(JSONObject().apply { put("type", "ice-candidate"); put("candidate", candidate) })
    }

    fun close() {
        Log.d(TAG, "close() called")
        closedIntentionally = true
        handler.removeCallbacksAndMessages(null)
        ws?.close()
    }
}
