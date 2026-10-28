package me.doil.drec.eink

import org.json.JSONArray
import org.json.JSONObject
import java.util.Random

/**
 * Excalidraw 요소 배열 모델 (Android 비의존 — JVM 단위테스트 대상).
 *
 * 데이터 안전 원칙: 기존 요소는 원본 JSONObject 그대로 보관하고, 우리가 만든 freedraw 의
 * 추가/삭제 표시(isDeleted)만 건드린다. 배열에서 요소를 제거하지 않는다.
 * 루트 객체의 다른 키(appState, files 등)도 그대로 보존한다.
 */
class Scene(private val root: JSONObject) {
    val elements: JSONArray = root.optJSONArray("elements") ?: JSONArray().also { root.put("elements", it) }

    /** 되돌리기 스택: 마지막에 추가한 요소(ADD) 또는 지운 요소(ERASE). */
    private class Action(val el: JSONObject, val added: Boolean)
    private val undo = ArrayList<Action>()

    val canUndo get() = undo.isNotEmpty()

    fun toJson(): String = root.toString()

    fun add(el: JSONObject) {
        elements.put(el)
        undo.add(Action(el, true))
    }

    fun erase(el: JSONObject, now: Long = System.currentTimeMillis(), rnd: Random = Random()) {
        if (el.optBoolean("isDeleted")) return
        setDeleted(el, true, now, rnd)
        undo.add(Action(el, false))
    }

    /** 마지막 add/erase 를 되돌린다. 추가 취소도 isDeleted 표시(저장된 뒤라도 안전). */
    fun undo(now: Long = System.currentTimeMillis(), rnd: Random = Random()): Boolean {
        val a = undo.removeLastOrNull() ?: return false
        setDeleted(a.el, a.added, now, rnd) // 추가 취소 → 삭제, 지움 취소 → 복원
        return true
    }

    /** 지울 수 있는 요소: 살아있는 freedraw 만. */
    fun liveFreedraws(): List<JSONObject> = buildList {
        for (i in 0 until elements.length()) {
            val e = elements.optJSONObject(i) ?: continue
            if (e.optString("type") == "freedraw" && !e.optBoolean("isDeleted")) add(e)
        }
    }

    companion object {
        /** canvas_data(문자열, 빈 값 가능) → Scene. 파싱 불가면 예외 — 호출 측이 저장을 막아야 한다. */
        fun parse(canvasData: String?): Scene {
            if (canvasData.isNullOrBlank()) return Scene(JSONObject())
            return Scene(JSONObject(canvasData))
        }

        private fun setDeleted(el: JSONObject, deleted: Boolean, now: Long, rnd: Random) {
            el.put("isDeleted", deleted)
            el.put("version", el.optInt("version", 1) + 1)
            el.put("versionNonce", rnd.nextInt(Int.MAX_VALUE))
            el.put("updated", now)
        }

        /** pts: 장면 좌표 (x0,y0,x1,y1,...). 최소 1점. */
        fun newFreedraw(
            pts: FloatArray, pressures: FloatArray, strokeWidth: Float,
            now: Long = System.currentTimeMillis(), rnd: Random = Random(),
        ): JSONObject {
            val n = pts.size / 2
            var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
            var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
            for (i in 0 until n) {
                minX = minOf(minX, pts[2 * i]); maxX = maxOf(maxX, pts[2 * i])
                minY = minOf(minY, pts[2 * i + 1]); maxY = maxOf(maxY, pts[2 * i + 1])
            }
            val points = JSONArray()
            val pr = JSONArray()
            for (i in 0 until n) {
                points.put(JSONArray().put((pts[2 * i] - minX).toDouble()).put((pts[2 * i + 1] - minY).toDouble()))
                pr.put((pressures.getOrNull(i) ?: 0.5f).toDouble())
            }
            return JSONObject()
                .put("id", randomId(rnd))
                .put("type", "freedraw")
                .put("x", minX.toDouble()).put("y", minY.toDouble())
                .put("width", (maxX - minX).toDouble()).put("height", (maxY - minY).toDouble())
                .put("angle", 0)
                .put("strokeColor", "#1e1e1e")
                .put("backgroundColor", "transparent")
                .put("fillStyle", "solid")
                .put("strokeWidth", strokeWidth.toDouble())
                .put("strokeStyle", "solid")
                .put("roughness", 0)
                .put("opacity", 100)
                .put("groupIds", JSONArray())
                .put("frameId", JSONObject.NULL)
                .put("roundness", JSONObject.NULL)
                .put("seed", rnd.nextInt(Int.MAX_VALUE))
                .put("version", 1)
                .put("versionNonce", rnd.nextInt(Int.MAX_VALUE))
                .put("isDeleted", false)
                .put("boundElements", JSONObject.NULL)
                .put("updated", now)
                .put("link", JSONObject.NULL)
                .put("locked", false)
                .put("index", JSONObject.NULL) // Excalidraw restore 가 복구
                .put("points", points)
                .put("pressures", pr)
                .put("simulatePressure", false)
                .put("lastCommittedPoint", JSONObject.NULL)
        }

        /** (x,y) 가 freedraw 의 어떤 선분과 r 이내인지 (장면 좌표). */
        fun hitsFreedraw(el: JSONObject, x: Float, y: Float, r: Float): Boolean {
            val pts = el.optJSONArray("points") ?: return false
            val ox = el.optDouble("x").toFloat(); val oy = el.optDouble("y").toFloat()
            var px = 0f; var py = 0f
            for (i in 0 until pts.length()) {
                val p = pts.optJSONArray(i) ?: continue
                val cx = ox + p.optDouble(0).toFloat(); val cy = oy + p.optDouble(1).toFloat()
                if (i == 0) { px = cx; py = cy }
                if (distToSegment(x, y, px, py, cx, cy) <= r) return true
                px = cx; py = cy
            }
            return false
        }

        private fun distToSegment(x: Float, y: Float, ax: Float, ay: Float, bx: Float, by: Float): Float {
            val dx = bx - ax; val dy = by - ay
            val len2 = dx * dx + dy * dy
            val t = if (len2 == 0f) 0f else (((x - ax) * dx + (y - ay) * dy) / len2).coerceIn(0f, 1f)
            val qx = ax + t * dx - x; val qy = ay + t * dy - y
            return Math.sqrt((qx * qx + qy * qy).toDouble()).toFloat()
        }

        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        private fun randomId(rnd: Random) = buildString { repeat(21) { append(ALPHABET[rnd.nextInt(ALPHABET.length)]) } }
    }
}
