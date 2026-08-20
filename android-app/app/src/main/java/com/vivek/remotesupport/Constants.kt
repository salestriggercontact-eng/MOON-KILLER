package com.vivek.remotesupport

object Constants {
    // Point these at your deployed backend / signaling server.
    const val BACKEND_URL = "https://moon-killer-backend.onrender.com"
    const val SIGNALING_URL = "wss://moon-killer-signaling-server.onrender.com"

    // TURN relay (used when direct STUN connection fails, e.g. restrictive
    // carrier NAT / firewalls). Free ExpressTURN tier - swap if usage grows.
    const val TURN_URL = "turn:free.expressturn.com:3478"
    const val TURN_USERNAME = "000000002102532665"
    const val TURN_PASSWORD = "TOF0yG1CBWto3Y5A5T7RtpQFbQs="

    const val HEARTBEAT_INTERVAL_MS = 30_000L
    const val PENDING_REQUEST_POLL_MS = 4_000L

    const val PREFS_NAME = "remote_support_prefs"
    const val PREF_DEVICE_CODE = "device_code"
    const val PREF_LISTENING_ENABLED = "listening_enabled"

    const val CHANNEL_ID_STATUS = "remote_support_status"
    const val CHANNEL_ID_REQUESTS = "remote_support_requests"
    const val CHANNEL_ID_ACTIVE_SESSION = "remote_support_active_session"

    const val NOTIF_ID_STATUS = 1001
    const val NOTIF_ID_REQUEST = 1002
    const val NOTIF_ID_ACTIVE_SESSION = 1003

    const val ACTION_RESPOND = "com.vivek.remotesupport.ACTION_RESPOND"
    const val EXTRA_REQUEST_ID = "extra_request_id"
    const val EXTRA_APPROVE = "extra_approve"
    const val EXTRA_SIGNALING_ROOM = "extra_signaling_room"
    const val EXTRA_REQUEST_TYPE = "extra_request_type"
    const val EXTRA_ADMIN_USERNAME = "extra_admin_username"
}
