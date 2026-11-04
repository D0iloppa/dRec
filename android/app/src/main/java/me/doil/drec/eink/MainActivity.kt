package me.doil.drec.eink

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.app.Activity
import android.widget.FrameLayout

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var overlay: InkOverlay? = null
    private var pendingPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // 회의 중 화면 유지
        root = FrameLayout(this)
        web = WebView(this).apply {
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { handlePermission(request) }
                }
            }
            addJavascriptInterface(Bridge(), "DrecInk")
        }
        root.addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(HOME)
    }

    // ---- 마이크: 페이지(getUserMedia)가 요청 → 런타임 권한 후 오디오 캡처만 허용 ----
    private fun handlePermission(req: PermissionRequest) {
        if (req.origin.host != HOST || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in req.resources) { req.deny(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            pendingPermission?.deny()
            pendingPermission = req
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code != REQ_AUDIO) return
        val req = pendingPermission ?: return
        pendingPermission = null
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
    }

    // ---- JS 브리지 (고정 계약): DrecInk.open(meetingId, token) ----
    private inner class Bridge {
        @JavascriptInterface
        fun open(meetingId: Int, token: String) {
            runOnUiThread {
                // 우리 페이지에서 온 호출만 허용
                if (Uri.parse(web.url ?: "").host != HOST) return@runOnUiThread
                if (overlay != null || meetingId <= 0 || token.isBlank()) return@runOnUiThread
                val ov = InkOverlay(this@MainActivity, meetingId, token) { closeOverlay(meetingId) }
                overlay = ov
                root.addView(ov, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        }

        /** rect: CSS px (getBoundingClientRect, WebView 뷰포트 기준). 이미 열려 있으면 무시. */
        @JavascriptInterface
        fun openInline(meetingId: Int, token: String, x: Float, y: Float, w: Float, h: Float) {
            runOnUiThread {
                if (Uri.parse(web.url ?: "").host != HOST) return@runOnUiThread
                if (overlay != null || meetingId <= 0 || token.isBlank() || w <= 0f || h <= 0f) return@runOnUiThread
                val ov = InkOverlay(this@MainActivity, meetingId, token, inline = true) { closeOverlay(meetingId) }
                overlay = ov
                root.addView(ov, inlineParams(x, y, w, h))
            }
        }

        @JavascriptInterface
        fun updateRect(x: Float, y: Float, w: Float, h: Float) {
            runOnUiThread {
                val ov = overlay ?: return@runOnUiThread
                if (!ov.isInline || w <= 0f || h <= 0f) return@runOnUiThread
                ov.layoutParams = inlineParams(x, y, w, h)
                ov.onRectChanged()
            }
        }

        @JavascriptInterface
        fun close() { runOnUiThread { overlay?.close() } }
    }

    /**
     * CSS px → 기기 px. 페이지가 width=device-width, initial-scale=1, user-scalable=no 라 줌이 없으므로
     * WebView 스케일 = displayMetrics.density (WebView.getScale 은 deprecated). 페이지가 줌 가능해지면 재검토.
     * WebView 의 root 내 오프셋은 getLocationInWindow 차이로 더한다.
     */
    private fun inlineParams(x: Float, y: Float, w: Float, h: Float): FrameLayout.LayoutParams {
        val d = resources.displayMetrics.density
        val a = IntArray(2); val b = IntArray(2)
        web.getLocationInWindow(a); root.getLocationInWindow(b)
        return FrameLayout.LayoutParams(Math.round(w * d), Math.round(h * d)).apply {
            leftMargin = Math.round(x * d) + a[0] - b[0]
            topMargin = Math.round(y * d) + a[1] - b[1]
        }
    }

    private fun closeOverlay(meetingId: Int) {
        overlay?.let { root.removeView(it) }
        overlay = null
        web.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('drec-ink-closed',{detail:{meetingId:$meetingId}}))", null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val ov = overlay
        when {
            ov != null -> ov.close()
            web.canGoBack() -> web.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onPause() { overlay?.onPause(); web.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); web.onResume(); overlay?.onResume() }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    override fun onDestroy() {
        overlay?.dispose()
        overlay = null
        super.onDestroy()
    }

    companion object {
        private const val HOST = "drec.doil.me"
        private const val HOME = "https://$HOST"
        private const val REQ_AUDIO = 1
    }
}
