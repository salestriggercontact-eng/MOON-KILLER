package com.vivek.remotesupport

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.DisplayMetrics
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import org.webrtc.*
import java.util.UUID

/**
 * Foreground service (type=mediaProjection) that runs only while a
 * session the user approved is active. Persistent notification with a
 * Stop button is shown the entire time. Handles the screen-share video
 * track, an optional camera track (only if the admin explicitly
 * requests it and toggles it off again), and the control data channel.
 */
class ScreenCaptureService : Service(), SignalingClient.Listener {

    private lateinit var eglBase: EglBase
    private lateinit var factory: PeerConnectionFactory
    private var peerConnection: PeerConnection? = null
    private var screenCapturer: VideoCapturer? = null
    private var cameraCapturer: CameraVideoCapturer? = null
    private var cameraVideoTrack: VideoTrack? = null
    private var cameraSender: RtpSender? = null
    private var isFrontCamera = true
    private var dataChannel: DataChannel? = null
    private lateinit var signaling: SignalingClient
    private lateinit var displayMetrics: DisplayMetrics
    private val deviceCode: String by lazy {
        getSharedPreferences(Constants.PREFS_NAME, MODE_PRIVATE).getString(Constants.PREF_DEVICE_CODE, "") ?: ""
    }

    private val CHUNK_SIZE = 48_000 // stay comfortably under typical data channel message limits

    override fun onCreate() {
        super.onCreate()
        eglBase = EglBase.create()
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()

        displayMetrics = DisplayMetrics().also {
            (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getMetrics(it)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra("resultCode", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val permissionData = intent?.getParcelableExtra<Intent>("data")
        val room = intent?.getStringExtra(Constants.EXTRA_SIGNALING_ROOM)

        if (resultCode != Activity.RESULT_OK || permissionData == null || room == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(Constants.NOTIF_ID_ACTIVE_SESSION, activeSessionNotification())
        startCaptureAndSignaling(permissionData, room)
        return START_NOT_STICKY
    }

    private fun activeSessionNotification(): Notification {
        val stopIntent = Intent(this, ScreenCaptureService::class.java).apply { action = ACTION_STOP }
        val stopPending = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, Constants.CHANNEL_ID_ACTIVE_SESSION)
            .setContentTitle(getString(R.string.notif_active_session_title))
            .setContentText(getString(R.string.notif_active_session_text))
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, getString(R.string.stop_session), stopPending)
            .build()
    }

    private fun startCaptureAndSignaling(permissionData: Intent, room: String) {
        val videoSource = factory.createVideoSource(true)
        val surfaceHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglBaseContext)

        screenCapturer = ScreenCapturerAndroid(
            permissionData,
            object : android.media.projection.MediaProjection.Callback() {
                override fun onStop() { stopSelf() }
            }
        )
        screenCapturer?.initialize(surfaceHelper, applicationContext, videoSource.capturerObserver)
        screenCapturer?.startCapture(displayMetrics.widthPixels, displayMetrics.heightPixels, 30)

        val screenTrack = factory.createVideoTrack("screen0", videoSource)

        val rtcConfig = PeerConnection.RTCConfiguration(
            listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder(Constants.TURN_URL)
                    .setUsername(Constants.TURN_USERNAME)
                    .setPassword(Constants.TURN_PASSWORD)
                    .createIceServer()
            )
        )

        peerConnection = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                signaling.sendIceCandidate(JSONObject().apply {
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                    put("candidate", candidate.sdp)
                })
            }
            override fun onDataChannel(channel: DataChannel) {
                dataChannel = channel
                registerDataChannelObserver(channel)
            }
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                if (state == PeerConnection.IceConnectionState.FAILED ||
                    state == PeerConnection.IceConnectionState.CLOSED
                ) {
                    stopSelf()
                }
            }
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onRenegotiationNeeded() {
                // Fired e.g. after adding/removing the camera track.
                // Re-offer so the admin side picks up the track change.
                createAndSendOffer()
            }
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        })

        peerConnection?.addTrack(screenTrack, listOf("screen_stream"))

        // Debounced hint that on-screen content changed - the admin
        // decides whether to actually pull a fresh tree, this never
        // pushes tree content automatically.
        RemoteControlAccessibilityService.instance?.onContentPossiblyChanged = {
            sendJson(JSONObject().apply { put("type", "ui-tree-stale") })
        }

        signaling = SignalingClient(room, this)
        signaling.connect()
    }

    private fun createAndSendOffer() {
        val pc = peerConnection ?: return
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(SimpleSdpObserver(), desc)
                signaling.send(JSONObject().apply {
                    put("type", "offer")
                    put("offer", JSONObject().apply {
                        put("type", "offer")
                        put("sdp", desc.description)
                    })
                })
            }
        }, MediaConstraints())
    }

    // ---- Data channel: control commands in, tree/screenshot data out ----

    private fun registerDataChannelObserver(channel: DataChannel) {
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val json = try { JSONObject(String(bytes)) } catch (e: Exception) {
                    sendJson(JSONObject().apply {
                        put("type", "control_result"); put("success", false); put("error", "Malformed message")
                    })
                    return
                }
                when (json.optString("type")) {
                    "control" -> handleControlMessage(json)
                    "get-ui-tree" -> handleGetUiTree()
                    "accessibility_action" -> handleAccessibilityAction(json)
                    "screenshot" -> handleScreenshot()
                    "start-camera" -> startCamera()
                    "stop-camera" -> stopCamera()
                    "switch-camera" -> switchCamera()
                    else -> sendJson(JSONObject().apply {
                        put("type", "control_result"); put("success", false)
                        put("error", "Unknown message type: ${json.optString("type")}")
                    })
                }
            }
        })
    }

    private val ALLOWED_COMMANDS = setOf(
        "tap", "long_press", "swipe", "scroll", "back", "home", "recents", "type_text"
    )

    /**
     * Strict schema per spec: {"type":"control","command":"tap","x":0.4,"y":0.7}
     * (x/y are 0.0-1.0 fractions of screen size, not raw pixels - this
     * keeps taps accurate regardless of the phone's actual resolution,
     * which the admin side has no reliable way to know in advance).
     * Every field is validated before any gesture is dispatched. No
     * command outside ALLOWED_COMMANDS is ever executed - this is the
     * single dispatch point for anything arriving over the network, and
     * nothing here evaluates code or strings from the peer as anything
     * other than these fixed, whitelisted fields.
     */
    private fun handleControlMessage(json: JSONObject) {
        val command = json.optString("command")
        val svc = RemoteControlAccessibilityService.instance

        fun result(success: Boolean, error: String? = null) {
            sendJson(JSONObject().apply {
                put("type", "control_result")
                put("command", command)
                put("success", success)
                if (error != null) put("error", error)
            })
            ApiClient.reportAuditEvent(deviceCode, "control_action", success, command)
        }

        if (command !in ALLOWED_COMMANDS) {
            result(false, "Unknown command: $command")
            return
        }
        if (svc == null) {
            result(false, "Accessibility service not connected")
            return
        }

        try {
            when (command) {
                "tap" -> {
                    val x = requireFraction(json, "x") ?: return result(false, "Invalid or missing x")
                    val y = requireFraction(json, "y") ?: return result(false, "Invalid or missing y")
                    svc.tap(x, y, displayMetrics.widthPixels, displayMetrics.heightPixels)
                    result(true)
                }
                "long_press" -> {
                    val x = requireFraction(json, "x") ?: return result(false, "Invalid or missing x")
                    val y = requireFraction(json, "y") ?: return result(false, "Invalid or missing y")
                    svc.longPress(x, y, displayMetrics.widthPixels, displayMetrics.heightPixels)
                    result(true)
                }
                "swipe" -> {
                    val x1 = requireFraction(json, "x1") ?: return result(false, "Invalid or missing x1")
                    val y1 = requireFraction(json, "y1") ?: return result(false, "Invalid or missing y1")
                    val x2 = requireFraction(json, "x2") ?: return result(false, "Invalid or missing x2")
                    val y2 = requireFraction(json, "y2") ?: return result(false, "Invalid or missing y2")
                    val duration = json.optLong("durationMs", 300).coerceIn(50, 5000)
                    svc.swipe(
                        x1 * displayMetrics.widthPixels, y1 * displayMetrics.heightPixels,
                        x2 * displayMetrics.widthPixels, y2 * displayMetrics.heightPixels,
                        duration
                    )
                    result(true)
                }
                "scroll" -> {
                    val direction = json.optString("direction")
                    if (direction !in setOf("up", "down", "left", "right")) {
                        return result(false, "Invalid direction: $direction")
                    }
                    svc.scroll(direction, displayMetrics.widthPixels, displayMetrics.heightPixels)
                    result(true)
                }
                "back" -> { svc.back(); result(true) }
                "home" -> { svc.home(); result(true) }
                "recents" -> { svc.recents(); result(true) }
                "type_text" -> {
                    val text = json.optString("text")
                    if (text.isEmpty()) return result(false, "Empty text")
                    if (text.length > 2000) return result(false, "Text too long")
                    val ok = svc.typeText(text)
                    result(ok, if (ok) null else "No focused editable field")
                }
            }
        } catch (e: Exception) {
            result(false, "Command failed: ${e.message}")
        }
    }

    private fun requireFraction(json: JSONObject, key: String): Float? {
        if (!json.has(key)) return null
        val v = json.optDouble(key, Double.NaN)
        if (v.isNaN() || v < 0.0 || v > 1.0) return null
        return v.toFloat()
    }

    private fun handleGetUiTree() {
        val svc = RemoteControlAccessibilityService.instance
        val tree = svc?.extractUiTree()
            ?: JSONObject().put("error", "Accessibility service not connected")
        sendChunked("ui-tree", tree.toString())
    }

    /**
     * Protocol: {"type":"accessibility_action","nodeId":"n4","action":"CLICK","text":"..."}
     * Only the fixed action names in
     * RemoteControlAccessibilityService.ALLOWED_NODE_ACTIONS are ever
     * dispatched; the node itself is re-validated (must still exist,
     * must currently report supporting the requested action) before
     * anything runs. After a successful action, the tree is
     * re-extracted and pushed to the admin automatically.
     */
    private fun handleAccessibilityAction(json: JSONObject) {
        val nodeId = json.optString("nodeId")
        val action = json.optString("action")
        val text = if (json.has("text")) json.optString("text") else null

        val svc = RemoteControlAccessibilityService.instance
        if (svc == null) {
            sendJson(JSONObject().apply {
                put("type", "accessibility_action_result")
                put("success", false); put("error", "Accessibility service not connected")
            })
            return
        }
        if (nodeId.isEmpty() || action.isEmpty()) {
            sendJson(JSONObject().apply {
                put("type", "accessibility_action_result")
                put("success", false); put("error", "nodeId and action are required")
            })
            return
        }

        val (ok, error) = svc.performNodeAction(nodeId, action, text)
        ApiClient.reportAuditEvent(deviceCode, "control_action", ok, "node_$action")

        sendJson(JSONObject().apply {
            put("type", "accessibility_action_result")
            put("nodeId", nodeId); put("action", action)
            put("success", ok)
            if (error != null) put("error", error)
        })

        if (ok) {
            // Give the UI a moment to settle before re-reading it.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                handleGetUiTree()
            }, 300)
        }
    }

    private fun handleScreenshot() {
        val svc = RemoteControlAccessibilityService.instance
        if (svc == null) {
            sendJson(JSONObject().apply {
                put("type", "screenshot-error")
                put("error", "Accessibility service not connected")
            })
            return
        }
        svc.takeScreenshotSafe { ok, base64, error ->
            ApiClient.reportAuditEvent(deviceCode, "screenshot_requested", ok)
            if (ok && base64 != null) {
                sendChunked("screenshot", base64)
            } else {
                sendJson(JSONObject().apply {
                    put("type", "screenshot-error")
                    put("error", error ?: "Screenshot failed")
                })
            }
        }
    }

    private fun sendJson(json: JSONObject) {
        dataChannel?.let { ch ->
            if (ch.state() == DataChannel.State.OPEN) {
                val bytes = json.toString().toByteArray()
                ch.send(DataChannel.Buffer(java.nio.ByteBuffer.wrap(bytes), false))
            }
        }
    }

    /** Splits a large payload into chunk messages the admin app reassembles by id. */
    private fun sendChunked(type: String, payload: String) {
        val id = UUID.randomUUID().toString()
        val totalChunks = (payload.length + CHUNK_SIZE - 1) / CHUNK_SIZE

        sendJson(JSONObject().apply {
            put("type", "$type-start"); put("id", id); put("totalChunks", totalChunks)
        })

        for (i in 0 until totalChunks) {
            val start = i * CHUNK_SIZE
            val end = minOf(start + CHUNK_SIZE, payload.length)
            sendJson(JSONObject().apply {
                put("type", "$type-chunk"); put("id", id)
                put("index", i); put("data", payload.substring(start, end))
            })
        }

        sendJson(JSONObject().apply { put("type", "$type-end"); put("id", id) })
    }

    // ---- Camera (toggled on/off by explicit admin command; front/back
    // switchable while active where the device hardware supports it) ----

    private fun startCamera(preferFront: Boolean = true) {
        if (cameraCapturer != null) return // already on

        val enumerator = Camera2Enumerator(applicationContext)
        val targetId = enumerator.deviceNames.firstOrNull {
            if (preferFront) enumerator.isFrontFacing(it) else enumerator.isBackFacing(it)
        } ?: enumerator.deviceNames.firstOrNull()

        if (targetId == null) {
            sendJson(JSONObject().apply { put("type", "camera-error"); put("error", "No camera available") })
            return
        }
        isFrontCamera = enumerator.isFrontFacing(targetId)

        val cameraSource = factory.createVideoSource(false)
        val surfaceHelper = SurfaceTextureHelper.create("CameraThread", eglBase.eglBaseContext)
        val capturer = enumerator.createCapturer(targetId, null) as? CameraVideoCapturer ?: run {
            sendJson(JSONObject().apply { put("type", "camera-error"); put("error", "Could not open camera") })
            return
        }
        capturer.initialize(surfaceHelper, applicationContext, cameraSource.capturerObserver)
        capturer.startCapture(640, 480, 24)
        cameraCapturer = capturer

        val track = factory.createVideoTrack("camera0", cameraSource)
        cameraVideoTrack = track
        cameraSender = peerConnection?.addTrack(track, listOf("camera_stream"))
        // addTrack triggers onRenegotiationNeeded -> re-offer happens automatically.

        ApiClient.reportAuditEvent(deviceCode, "camera_started", true)
        sendJson(JSONObject().apply { put("type", "camera-started"); put("facing", if (isFrontCamera) "front" else "back") })
    }

    private fun switchCamera() {
        val capturer = cameraCapturer
        if (capturer == null) {
            sendJson(JSONObject().apply { put("type", "camera-error"); put("error", "Camera not active") })
            return
        }
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCameraNow: Boolean) {
                isFrontCamera = isFrontCameraNow
                sendJson(JSONObject().apply {
                    put("type", "camera-switched")
                    put("facing", if (isFrontCameraNow) "front" else "back")
                })
            }
            override fun onCameraSwitchError(errorDescription: String?) {
                sendJson(JSONObject().apply {
                    put("type", "camera-error")
                    put("error", errorDescription ?: "Camera switch failed")
                })
            }
        })
    }

    private fun stopCamera() {
        cameraCapturer?.stopCapture()
        cameraCapturer?.dispose()
        cameraCapturer = null

        cameraSender?.let { peerConnection?.removeTrack(it) }
        cameraSender = null
        cameraVideoTrack?.dispose()
        cameraVideoTrack = null

        ApiClient.reportAuditEvent(deviceCode, "camera_stopped", true)
        sendJson(JSONObject().apply { put("type", "camera-stopped") })
    }

    // ---- SignalingClient.Listener ----

    override fun onOpen() {}

    override fun onOffer(offer: JSONObject) {
        val sdp = SessionDescription(SessionDescription.Type.OFFER, offer.getString("sdp"))
        peerConnection?.setRemoteDescription(SimpleSdpObserver(), sdp)
        peerConnection?.createAnswer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                peerConnection?.setLocalDescription(SimpleSdpObserver(), desc)
                signaling.sendAnswer(JSONObject().apply {
                    put("type", "answer")
                    put("sdp", desc.description)
                })
            }
        }, MediaConstraints())
    }

    override fun onIceCandidate(candidate: JSONObject) {
        peerConnection?.addIceCandidate(
            IceCandidate(
                candidate.optString("sdpMid"),
                candidate.optInt("sdpMLineIndex"),
                candidate.optString("candidate")
            )
        )
    }

    override fun onPeerLeft() = stopSelf()
    override fun onStopSession() = stopSelf()

    override fun onDestroy() {
        super.onDestroy()
        RemoteControlAccessibilityService.instance?.onContentPossiblyChanged = null
        stopCamera()
        screenCapturer?.stopCapture()
        screenCapturer?.dispose()
        peerConnection?.close()
        if (::signaling.isInitialized) signaling.close()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.vivek.remotesupport.ACTION_STOP"
    }
}

/** Minimal SdpObserver base so each call site only overrides what it needs. */
open class SimpleSdpObserver : SdpObserver {
    override fun onCreateSuccess(p0: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(p0: String?) {}
    override fun onSetFailure(p0: String?) {}
}
