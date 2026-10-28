package me.doil.drec.eink

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * WebView 위에 얹는 전체화면 잉크 오버레이 (같은 Activity — 페이지의 녹음이 끊기지 않게).
 * Boox: Onyx Pen SDK raw drawing(EPD 저지연). 그 외: MotionEvent 캔버스 폴백.
 * onClosed 는 최종 저장이 끝난(또는 실패를 알린) 뒤 메인 스레드에서 1회 호출된다.
 */
class InkOverlay(
    context: Context,
    private val meetingId: Int,
    private val token: String,
    private val onClosed: () -> Unit,
) : FrameLayout(context) {

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val density = resources.displayMetrics.density
    private val renderer = Renderer(density)

    private var scene: Scene? = null          // 로드 성공 전에는 null — 이 동안 저장 금지
    private var rev = 0                       // 변경 횟수
    private var savedRev = 0
    private var closing = false

    private enum class Tool { PEN, ERASER }
    private var tool = Tool.PEN
    private val widths = floatArrayOf(2f, 5f) // 장면 px(CSS px) 프리셋
    private var widthIdx = 0

    private val surface = SurfaceView(context)
    private var bitmap: Bitmap? = null
    private var bmpCanvas: Canvas? = null
    private var surfaceReady = false

    private var touchHelper: TouchHelper? = null
    // Boox 판별은 진단/폴백 판단용일 뿐 — TouchHelper 는 제조사와 무관하게 항상 시도한다.
    private val onyxLike = Build.MANUFACTURER.contains("onyx", true) || Build.BRAND.contains("onyx", true) ||
        Build.MANUFACTURER.contains("boox", true) || Build.BRAND.contains("boox", true)
    @Volatile private var rawSeen = false      // 첫 raw 점을 실제로 받았는가
    private var rawFail: String? = null
    // 비-Boox 에서 TouchHelper 가 예외 없이 열려도 입력이 안 올 수 있으니, 첫 raw 점 전에는 MotionEvent 도 허용
    private val onyxActive get() = touchHelper != null && (onyxLike || rawSeen)
    private lateinit var modeLabel: TextView

    private lateinit var penBtn: TextView
    private lateinit var eraserBtn: TextView
    private lateinit var widthBtn: TextView
    private lateinit var status: TextView

    init {
        setBackgroundColor(Color.WHITE)
        isClickable = true // 아래 WebView 로 터치가 새지 않게
        val col = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        col.addView(buildToolbar(), LayoutParams(LayoutParams.MATCH_PARENT, dp(64)))
        col.addView(surface, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(col, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        status = TextView(context).apply { text = "불러오는 중..."; textSize = 20f; setTextColor(Color.BLACK) }
        addView(status, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        surface.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) { surfaceReady = true }
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) { onSurfaceSized(w, hh) }
            override fun surfaceDestroyed(h: SurfaceHolder) { surfaceReady = false; closeRaw() }
        })
        surface.setOnTouchListener { _, ev -> onSurfaceTouch(ev) }

        io.execute {
            try {
                val s = Scene.parse(CanvasApi.load(meetingId, token))
                main.post { scene = s; status.visibility = GONE; refreshButtons(); redraw() }
            } catch (e: Exception) {
                // 로드 실패 시 편집/저장 금지 — 빈 캔버스로 덮어쓰는 사고 방지
                main.post { toast("캔버스를 불러오지 못했습니다: ${e.message}"); finish() }
            }
        }
    }

    // ---------- toolbar ----------
    private fun buildToolbar(): View {
        val bar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
        }
        fun btn(label: String, onClick: () -> Unit) = TextView(context).apply {
            text = label; textSize = 20f; gravity = Gravity.CENTER
            minWidth = dp(96); setPadding(dp(16), 0, dp(16), 0)
            setOnClickListener { if (!closing) onClick() }
            bar.addView(this, LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply { setMargins(dp(2), dp(2), dp(2), dp(2)) })
        }
        penBtn = btn("펜") { tool = Tool.PEN; refreshButtons(); applyRawState() }
        eraserBtn = btn("지우개") { tool = Tool.ERASER; refreshButtons(); applyRawState() }
        btn("실행취소") { if (scene?.undo() == true) { changed(); redraw() } }
        widthBtn = btn("굵기") { widthIdx = (widthIdx + 1) % widths.size; refreshButtons(); applyStrokeWidth() }
        btn("닫기") { close() }
        modeLabel = TextView(context).apply { textSize = 12f; gravity = Gravity.CENTER; setTextColor(Color.BLACK); text = "..." }
        bar.addView(modeLabel, LinearLayout.LayoutParams(dp(130), LayoutParams.MATCH_PARENT))
        refreshButtons()
        return bar
    }

    private fun refreshButtons() {
        fun style(v: TextView, on: Boolean) {
            v.setTextColor(if (on) Color.WHITE else Color.BLACK)
            v.background = GradientDrawable().apply {
                setColor(if (on) Color.BLACK else Color.WHITE); setStroke(dp(2), Color.BLACK)
            }
        }
        style(penBtn, tool == Tool.PEN); style(eraserBtn, tool == Tool.ERASER)
        widthBtn.text = if (widthIdx == 0) "굵기: 가늘게" else "굵기: 굵게"
        for (i in 0 until (penBtn.parent as LinearLayout).childCount) {
            val v = (penBtn.parent as LinearLayout).getChildAt(i) as TextView
            if (v !== penBtn && v !== eraserBtn && v !== modeLabel) style(v, false)
        }
    }

    // ---------- surface / rendering ----------
    private fun onSurfaceSized(w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        bitmap?.recycle()
        bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bmpCanvas = Canvas(it) }
        redraw()
        openRaw()
        applyRawState()
    }

    /** 장면 → 비트맵 → 서피스. EPD raw drawing 이 켜져 있으면 잠깐 끄고 그린다. */
    private fun redraw() {
        val c = bmpCanvas ?: return
        val s = scene
        val wasRaw = onyxActive && rawWanted()
        if (wasRaw) touchHelper?.setRawDrawingEnabled(false)
        if (s != null) renderer.drawAll(c, s) else c.drawColor(Color.WHITE)
        blit()
        if (wasRaw) touchHelper?.setRawDrawingEnabled(true)
    }

    private fun blit() {
        val bmp = bitmap ?: return
        if (!surfaceReady) return
        val holder = surface.holder
        val canvas = try { holder.lockCanvas() } catch (_: Exception) { null } ?: return
        try { canvas.drawBitmap(bmp, 0f, 0f, null) } finally { holder.unlockCanvasAndPost(canvas) }
    }

    // ---------- Onyx raw drawing ----------
    /** 데모(ScribbleTouchHelperDemoActivity)와 같은 순서: create(1회) → setLimitRect(레이아웃 후 로컬 rect) → openRawDrawing. */
    private fun openRaw() {
        try {
            val limit = Rect()
            surface.getLocalVisibleRect(limit)
            if (limit.isEmpty) { Log.w(TAG, "limitRect empty, skip"); return }
            var helper = touchHelper
            if (helper == null) {
                helper = TouchHelper.create(surface, rawCallback)
                Log.i(TAG, "TouchHelper.create ok (mfr=${Build.MANUFACTURER} brand=${Build.BRAND})")
                helper.setStrokeWidth(widths[widthIdx] * density).setStrokeColor(Color.BLACK)
                helper.setLimitRect(limit, emptyList<Rect>())
                Log.i(TAG, "setLimitRect $limit")
                helper.openRawDrawing()
                Log.i(TAG, "openRawDrawing ok")
                helper.setRawDrawingRenderEnabled(true) // EPD 가 펜 선을 직접 그린다 (앱은 종료 후 비트맵에만 반영)
                touchHelper = helper
            } else {
                helper.setLimitRect(limit, emptyList<Rect>()) // 크기 변경 시 rect 만 갱신 (재생성 없음)
                Log.i(TAG, "setLimitRect(update) $limit")
            }
            setMode("RAW" + if (rawSeen) "" else "?")
        } catch (t: Throwable) {
            Log.e(TAG, "raw drawing unavailable", t)
            try { touchHelper?.closeRawDrawing() } catch (_: Throwable) {}
            touchHelper = null // SDK 사용 불가 → MotionEvent 폴백
            setMode("FALLBACK: ${t.javaClass.simpleName}")
        }
    }

    private fun setMode(m: String) { Log.i(TAG, "mode=$m"); modeLabel.text = m }

    private fun closeRaw() {
        try { touchHelper?.closeRawDrawing() } catch (_: Throwable) {}
        touchHelper = null
    }

    private fun rawWanted() = tool == Tool.PEN && scene != null && !closing

    private fun applyRawState() {
        try {
            touchHelper?.setRawDrawingEnabled(rawWanted())
            if (touchHelper != null) Log.i(TAG, "setRawDrawingEnabled(${rawWanted()})")
        } catch (t: Throwable) { Log.e(TAG, "setRawDrawingEnabled", t) }
    }

    private fun applyStrokeWidth() {
        try { touchHelper?.setStrokeWidth(widths[widthIdx] * density) } catch (_: Throwable) {}
    }

    private val maxPressure: Float by lazy {
        try { com.onyx.android.sdk.api.device.epd.EpdController.getMaxTouchPressure().takeIf { it > 0f } ?: 1f } catch (_: Throwable) { 1f }
    }

    // SDK 콜백은 비 UI 스레드 — 메인으로 넘긴다.
    private val rawCallback = object : RawInputCallback() {
        override fun onBeginRawDrawing(b: Boolean, p: TouchPoint) { if (!rawSeen) Log.i(TAG, "first raw begin") }
        override fun onEndRawDrawing(b: Boolean, p: TouchPoint) {}
        override fun onRawDrawingTouchPointMoveReceived(p: TouchPoint) {}
        override fun onRawDrawingTouchPointListReceived(list: TouchPointList) {
            if (!rawSeen) { rawSeen = true; Log.i(TAG, "first raw stroke received"); main.post { setMode("RAW") } }
            val n = list.size()
            val xy = FloatArray(n * 2); val pr = FloatArray(n)
            for (i in 0 until n) {
                val p = list.get(i)
                xy[2 * i] = p.x; xy[2 * i + 1] = p.y
                pr[i] = (p.pressure / maxPressure).coerceIn(0f, 1f)
            }
            main.post { commitStroke(xy, pr, drawNow = false) }
        }
        override fun onBeginRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onEndRawErasing(b: Boolean, p: TouchPoint) {}
        override fun onRawErasingTouchPointMoveReceived(p: TouchPoint) {}
        override fun onRawErasingTouchPointListReceived(list: TouchPointList) {}
    }

    // ---------- MotionEvent (폴백 펜 + 모든 기기의 지우개) ----------
    private var cur = ArrayList<Float>()
    private var curP = ArrayList<Float>()

    private fun onSurfaceTouch(ev: MotionEvent): Boolean {
        if (scene == null || closing) return true
        if (tool == Tool.ERASER) {
            if (ev.actionMasked == MotionEvent.ACTION_DOWN || ev.actionMasked == MotionEvent.ACTION_MOVE) eraseAt(ev.x, ev.y)
            return true
        }
        if (onyxActive) return true // raw drawing 이 펜 입력을 처리
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { cur.clear(); curP.clear(); addPoint(ev.x, ev.y, ev.pressure) }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until ev.historySize) addPoint(ev.getHistoricalX(i), ev.getHistoricalY(i), ev.getHistoricalPressure(i))
                addPoint(ev.x, ev.y, ev.pressure)
                liveSegment()
            }
            MotionEvent.ACTION_UP -> {
                addPoint(ev.x, ev.y, ev.pressure)
                commitStroke(cur.toFloatArray(), curP.toFloatArray(), drawNow = false) // 선은 이미 비트맵에 그려짐
                cur.clear(); curP.clear()
            }
            MotionEvent.ACTION_CANCEL -> { cur.clear(); curP.clear(); redraw() }
        }
        return true
    }

    private fun addPoint(x: Float, y: Float, p: Float) { cur.add(x); cur.add(y); curP.add(p) }

    private val livePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    private fun liveSegment() {
        val c = bmpCanvas ?: return
        val n = cur.size / 2
        if (n < 2) return
        livePaint.strokeWidth = widths[widthIdx] * density
        val from = maxOf(0, n - 4) // 최근 몇 점만 이어 그림
        for (i in from until n - 1) c.drawLine(cur[2 * i], cur[2 * i + 1], cur[2 * i + 2], cur[2 * i + 3], livePaint)
        blit()
    }

    // ---------- model ops ----------
    /** xy: 서피스(기기 px) 좌표 → 장면 좌표(÷density + pan). */
    private fun commitStroke(xy: FloatArray, pressure: FloatArray, drawNow: Boolean) {
        val s = scene ?: return
        if (xy.size < 2) return
        val pts = FloatArray(xy.size) { i -> xy[i] / density + if (i % 2 == 0) renderer.panX else renderer.panY }
        val el = Scene.newFreedraw(pts, pressure, widths[widthIdx])
        s.add(el)
        bmpCanvas?.let { renderer.drawElement(it, el) } // 비트맵에도 반영 (EPD 는 이미 그렸음)
        if (drawNow) blit()
        changed()
    }

    private fun eraseAt(sx: Float, sy: Float) {
        val s = scene ?: return
        val x = sx / density + renderer.panX; val y = sy / density + renderer.panY
        var hit = false
        for (el in s.liveFreedraws()) if (Scene.hitsFreedraw(el, x, y, ERASE_RADIUS)) { s.erase(el); hit = true }
        if (hit) { changed(); redraw() }
    }

    // ---------- save ----------
    private val debounced = Runnable { saveAsync(null) }

    private fun changed() {
        rev++
        main.removeCallbacks(debounced)
        main.postDelayed(debounced, 1000)
    }

    /** done: 저장 시도 후 (성공 여부) 메인 스레드 콜백. 변경이 없으면 즉시 성공. */
    private fun saveAsync(done: ((Boolean) -> Unit)?) {
        val s = scene
        if (s == null || rev == savedRev) { done?.invoke(true); return }
        val json = s.toJson() // 메인 스레드에서 스냅샷
        val myRev = rev
        io.execute {
            val ok = try { CanvasApi.save(meetingId, token, json); true } catch (e: Exception) { false }
            main.post {
                if (ok && myRev > savedRev) savedRev = myRev
                if (!ok && done == null) toast("자동 저장 실패 — 닫을 때 다시 시도합니다")
                done?.invoke(ok)
            }
        }
    }

    // ---------- lifecycle ----------
    fun close() {
        if (closing) return
        closing = true
        main.removeCallbacks(debounced)
        closeRaw()
        status.text = "저장 중..."; status.visibility = VISIBLE
        saveAsync { ok ->
            if (!ok) toast("저장에 실패했습니다. 네트워크를 확인하세요.")
            finish()
        }
    }

    private var finished = false
    private fun finish() {
        if (finished) return
        finished = true
        closeRaw()
        io.shutdown()
        onClosed()
    }

    /** Activity 가 사라질 때: 남은 변경을 최대한 저장하고 정리 (UI 콜백 없음). */
    fun dispose() {
        if (finished) return
        finished = true; closing = true
        main.removeCallbacks(debounced)
        closeRaw()
        val s = scene
        if (s != null && rev != savedRev) {
            val json = s.toJson()
            io.execute { try { CanvasApi.save(meetingId, token, json) } catch (_: Exception) {} }
        }
        io.shutdown() // 대기 중 작업은 끝까지 실행
    }

    fun onPause() { try { touchHelper?.setRawDrawingEnabled(false) } catch (_: Throwable) {} }
    fun onResume() { redraw(); applyRawState() }

    private fun toast(msg: String) = Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    companion object { private const val TAG = "DrecInk"; private const val ERASE_RADIUS = 10f } // 장면 px
}
