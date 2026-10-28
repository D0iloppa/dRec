package me.doil.drec.eink

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import org.json.JSONObject

/** 장면(Excalidraw 요소)을 Canvas 에 그린다. e-ink 용 흑백, 기존 도형은 읽기 전용 윤곽선. */
class Renderer(private val density: Float) {
    var panX = 0f // 장면 좌표 (CSS px). 현재는 항상 0.
    var panY = 0f

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = 0xFF000000.toInt()
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF000000.toInt() }

    fun drawAll(canvas: Canvas, scene: Scene) {
        canvas.drawColor(0xFFFFFFFF.toInt())
        val els = scene.elements
        for (i in 0 until els.length()) els.optJSONObject(i)?.let { drawElement(canvas, it) }
    }

    fun drawElement(canvas: Canvas, e: JSONObject) {
        if (e.optBoolean("isDeleted")) return
        canvas.save()
        canvas.scale(density, density)
        canvas.translate(-panX, -panY)
        val x = e.optDouble("x").toFloat(); val y = e.optDouble("y").toFloat()
        val w = e.optDouble("width").toFloat(); val h = e.optDouble("height").toFloat()
        val angle = e.optDouble("angle", 0.0).toFloat()
        if (angle != 0f) canvas.rotate(Math.toDegrees(angle.toDouble()).toFloat(), x + w / 2, y + h / 2)
        stroke.strokeWidth = e.optDouble("strokeWidth", 1.0).toFloat().coerceAtLeast(1f)
        when (e.optString("type")) {
            "freedraw", "line", "arrow" -> {
                val p = polyline(e, x, y)
                if (p != null) canvas.drawPath(p, stroke)
            }
            "rectangle" -> canvas.drawRect(x, y, x + w, y + h, stroke)
            "ellipse" -> canvas.drawOval(x, y, x + w, y + h, stroke)
            "diamond" -> canvas.drawPath(Path().apply {
                moveTo(x + w / 2, y); lineTo(x + w, y + h / 2); lineTo(x + w / 2, y + h); lineTo(x, y + h / 2); close()
            }, stroke)
            "text" -> {
                val size = e.optDouble("fontSize", 20.0).toFloat()
                textPaint.textSize = size
                e.optString("text").split('\n').forEachIndexed { i, line ->
                    canvas.drawText(line, x, y + size * (i + 1), textPaint)
                }
            }
            // image/frame 등은 건너뜀 (원본은 보존됨)
        }
        canvas.restore()
    }

    private fun polyline(e: JSONObject, x: Float, y: Float): Path? {
        val pts = e.optJSONArray("points") ?: return null
        if (pts.length() == 0) return null
        val path = Path()
        for (i in 0 until pts.length()) {
            val p = pts.optJSONArray(i) ?: continue
            val px = x + p.optDouble(0).toFloat(); val py = y + p.optDouble(1).toFloat()
            if (i == 0) { path.moveTo(px, py); if (pts.length() == 1) path.lineTo(px + 0.1f, py) } else path.lineTo(px, py)
        }
        return path
    }
}
