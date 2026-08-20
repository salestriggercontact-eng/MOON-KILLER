package com.vivek.remotesupport

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Dispatches gestures (tap, long-press, swipe, scroll, back, home,
 * recents), permitted node-targeted actions, and, on explicit admin
 * request during an active user-approved session, extracts a bounded
 * UI tree for general troubleshooting - the same category of
 * capability every screen-reader accessibility service has always had.
 *
 * This service does NOT attempt to work around Android's own
 * FLAG_SECURE protections. Where the platform withholds node content
 * for a secure window, that content stays withheld here too - no
 * fallback capture path is implemented. Password-flagged fields are
 * exposed only as `isPassword: true`; their text is never read.
 */
class RemoteControlAccessibilityService : AccessibilityService() {

    companion object {
        var instance: RemoteControlAccessibilityService? = null
        private const val MAX_DEPTH = 12
        private const val MAX_CHILDREN_PER_NODE = 100
        private const val MAX_TOTAL_NODES = 3000
    }

    private var nodeCount = 0
    // Rebuilt on every extractUiTree() call - node references are only
    // ever valid for the tree snapshot they came from. Old entries are
    // cleared (not appended to) so this never grows unbounded.
    private val nodeCache = HashMap<String, AccessibilityNodeInfo>()

    // Debounced content-change notifications: the admin gets a "tree
    // may be stale, refresh if you want it" nudge, never an automatic
    // full-tree push on every keystroke/animation frame.
    private val eventHandler = Handler(Looper.getMainLooper())
    private var pendingContentChangeNotify: Runnable? = null
    var onContentPossiblyChanged: (() -> Unit)? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        nodeCache.clear()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_CLICKED,
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> debounceContentChangeNotify()
            else -> {}
        }
        // No event content (text, descriptions) is read or stored here -
        // only the event *type* is used, to know a refresh might be
        // worthwhile. The actual tree is only ever pulled on-demand.
    }

    private fun debounceContentChangeNotify() {
        pendingContentChangeNotify?.let { eventHandler.removeCallbacks(it) }
        val r = Runnable { onContentPossiblyChanged?.invoke() }
        pendingContentChangeNotify = r
        eventHandler.postDelayed(r, 600)
    }

    override fun onInterrupt() {}

    // ---- Gestures ----

    fun tap(xFraction: Float, yFraction: Float, screenWidth: Int, screenHeight: Int) {
        val x = (xFraction * screenWidth).coerceIn(0f, screenWidth.toFloat())
        val y = (yFraction * screenHeight).coerceIn(0f, screenHeight.toFloat())
        dispatchStroke(x, y, x, y, 50)
    }

    fun longPress(xFraction: Float, yFraction: Float, screenWidth: Int, screenHeight: Int) {
        val x = (xFraction * screenWidth).coerceIn(0f, screenWidth.toFloat())
        val y = (yFraction * screenHeight).coerceIn(0f, screenHeight.toFloat())
        dispatchStroke(x, y, x, y, 650)
    }

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 300) {
        dispatchStroke(x1, y1, x2, y2, durationMs)
    }

    fun scroll(direction: String, screenWidth: Int, screenHeight: Int) {
        val cx = screenWidth / 2f
        val cy = screenHeight / 2f
        val span = screenHeight * 0.35f
        when (direction) {
            "up" -> dispatchStroke(cx, cy + span / 2, cx, cy - span / 2, 300)
            "down" -> dispatchStroke(cx, cy - span / 2, cx, cy + span / 2, 300)
            "left" -> dispatchStroke(cx + span / 2, cy, cx - span / 2, cy, 300)
            "right" -> dispatchStroke(cx - span / 2, cy, cx + span / 2, cy, 300)
        }
    }

    private fun dispatchStroke(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        val path = Path().apply {
            moveTo(x1, y1)
            if (x1 != x2 || y1 != y2) lineTo(x2, y2)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1)))
            .build()
        dispatchGesture(gesture, null, null)
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)
    fun recents() = performGlobalAction(GLOBAL_ACTION_RECENTS)

    // ---- Safe text input (unfocused-field path, used by the "type_text"
    // control command - sets text on whatever is currently focused) ----

    fun typeText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = findFocusedEditableNode(root) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findFocusedEditableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused && node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val result = findFocusedEditableNode(child)
            if (result != null) return result
        }
        return null
    }

    // ---- UI tree extraction (bounded depth/children/total nodes,
    // node-identity cache rebuilt fresh each call) ----

    fun extractUiTree(): JSONObject {
        nodeCache.clear()
        val root = rootInActiveWindow
            ?: return JSONObject().put("error", "No active window content available")

        nodeCount = 0
        val tree = nodeToJson(root, 0)
            ?: JSONObject().put("error", "Protected content cannot be captured by Android.")

        return JSONObject().apply {
            put("packageName", root.packageName ?: "")
            put("tree", tree)
            put("nodeCount", nodeCount)
        }
    }

    private fun nodeToJson(node: AccessibilityNodeInfo, depth: Int): JSONObject? {
        if (depth > MAX_DEPTH || nodeCount >= MAX_TOTAL_NODES) return null

        val nodeId = "n${nodeCount}"
        nodeCount++
        nodeCache[nodeId] = node

        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val actions = JSONArray()
        for (action in node.actionList) {
            NODE_ACTION_NAMES[action.id]?.let { actions.put(it) }
        }

        val obj = JSONObject().apply {
            put("nodeId", nodeId)
            put("packageName", node.packageName?.toString() ?: "")
            put("className", node.className?.toString() ?: "")
            // Never expose text for a password-flagged field.
            put("text", if (node.isPassword) "" else (node.text?.toString() ?: ""))
            put("contentDescription", node.contentDescription?.toString() ?: "")
            put("resourceId", node.viewIdResourceName ?: "")
            put("bounds", JSONObject().apply {
                put("left", bounds.left); put("top", bounds.top)
                put("right", bounds.right); put("bottom", bounds.bottom)
            })
            put("clickable", node.isClickable)
            put("longClickable", node.isLongClickable)
            put("editable", node.isEditable)
            put("enabled", node.isEnabled)
            put("focusable", node.isFocusable)
            put("focused", node.isFocused)
            put("selected", node.isSelected)
            put("checked", node.isChecked)
            put("scrollable", node.isScrollable)
            put("isPassword", node.isPassword)
            put("availableActions", actions)
        }

        val children = JSONArray()
        val childLimit = minOf(node.childCount, MAX_CHILDREN_PER_NODE)
        for (i in 0 until childLimit) {
            if (nodeCount >= MAX_TOTAL_NODES) break
            val child = node.getChild(i) ?: continue
            val childJson = nodeToJson(child, depth + 1)
            if (childJson != null) children.put(childJson)
        }
        obj.put("children", children)
        return obj
    }

    // ---- Node-targeted actions: strict whitelist, validated against
    // the node's own reported capabilities before dispatch. Never
    // executes an arbitrary AccessibilityNodeInfo action id supplied
    // over the network - only these seven names, mapped locally. ----

    private val ALLOWED_NODE_ACTIONS = mapOf(
        "CLICK" to AccessibilityNodeInfo.ACTION_CLICK,
        "LONG_CLICK" to AccessibilityNodeInfo.ACTION_LONG_CLICK,
        "FOCUS" to AccessibilityNodeInfo.ACTION_FOCUS,
        "CLEAR_FOCUS" to AccessibilityNodeInfo.ACTION_CLEAR_FOCUS,
        "SCROLL_FORWARD" to AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
        "SCROLL_BACKWARD" to AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
        "SET_TEXT" to AccessibilityNodeInfo.ACTION_SET_TEXT
    )

    private val NODE_ACTION_NAMES = ALLOWED_NODE_ACTIONS.entries.associate { (name, id) -> id to name }

    /**
     * Performs a permitted action on a node referenced by the id from
     * the most recently extracted tree. Returns (success, error).
     * Rejects: unknown nodeId (not in the current cache - i.e. from a
     * stale/previous tree), an action name outside the fixed whitelist,
     * or an action the node itself doesn't currently report supporting.
     */
    fun performNodeAction(nodeId: String, actionName: String, text: String? = null): Pair<Boolean, String?> {
        val node = nodeCache[nodeId] ?: return false to "Unknown or stale nodeId"
        val actionId = ALLOWED_NODE_ACTIONS[actionName] ?: return false to "Unsupported action: $actionName"

        // Confirm the node still exists in the live hierarchy (not a
        // reference to a view that has since been removed/replaced).
        if (!node.refresh()) return false to "Node no longer exists in the current screen"

        val stillSupported = node.actionList.any { it.id == actionId }
        if (!stillSupported) return false to "Action not currently available on this node"

        return try {
            val ok = if (actionName == "SET_TEXT") {
                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text ?: "")
                }
                node.performAction(actionId, args)
            } else {
                node.performAction(actionId)
            }
            ok to if (ok) null else "performAction returned false"
        } catch (e: Exception) {
            false to "Action failed: ${e.message}"
        }
    }

    // ---- Screenshot (Android 11+ API; explicitly surfaces the
    // platform's own refusal for protected/secure windows rather than
    // attempting any workaround) ----

    fun takeScreenshotSafe(onResult: (ok: Boolean, base64Jpeg: String?, error: String?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            onResult(false, null, "Screenshot requires Android 11 or higher")
            return
        }
        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val hb = result.hardwareBuffer
                        val bitmap = android.graphics.Bitmap.wrapHardwareBuffer(hb, result.colorSpace)
                        hb.close()
                        if (bitmap == null) {
                            onResult(false, null, "Could not decode screenshot")
                            return
                        }
                        val software = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, false)
                        val stream = java.io.ByteArrayOutputStream()
                        software.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, stream)
                        val base64 = android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
                        onResult(true, base64, null)
                    } catch (e: Exception) {
                        onResult(false, null, "Screenshot capture failed: ${e.message}")
                    }
                }

                override fun onFailure(errorCode: Int) {
                    val message = if (errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) {
                        "Protected content cannot be captured by Android."
                    } else {
                        "Screenshot failed (code $errorCode)"
                    }
                    onResult(false, null, message)
                }
            }
        )
    }
}
