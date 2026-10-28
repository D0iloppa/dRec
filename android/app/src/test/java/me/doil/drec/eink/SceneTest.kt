package me.doil.drec.eink

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Random

class SceneTest {
    // 데스크톱 Excalidraw 가 만든 것처럼 낯선 필드가 섞인 외부 요소들
    private val rect = """{"id":"r1","type":"rectangle","x":10,"y":20,"width":100,"height":50,"customField":{"a":[1,2,3]},"version":7,"versionNonce":123,"isDeleted":false,"updated":1,"extra":"한글"}"""
    private val text = """{"id":"t1","type":"text","x":5,"y":5,"text":"hello","fontSize":20,"unknownFlag":true,"version":2,"versionNonce":9,"isDeleted":false,"updated":1}"""
    private val canvas = """{"type":"excalidraw","elements":[$rect,$text],"appState":{"zoom":1},"files":{}}"""

    private fun stroke(scene: Scene) = Scene.newFreedraw(floatArrayOf(10f, 20f, 30f, 5f), floatArrayOf(.4f, .6f), 2f)

    @Test fun foreignElementsPreservedThroughAddEraseUndo() {
        val scene = Scene.parse(canvas)
        val before = (0 until 2).map { scene.elements.getJSONObject(it).toString() }
        val s = stroke(scene)
        scene.add(s)
        scene.erase(s)
        scene.undo(); scene.undo()
        // 외부 요소는 직렬화 결과가 바이트 단위로 동일해야 한다
        val after = (0 until 2).map { scene.elements.getJSONObject(it).toString() }
        assertEquals(before, after)
        assertEquals(3, scene.elements.length()) // 요소는 절대 제거되지 않음
        // 루트의 다른 키 보존
        val out = JSONObject(scene.toJson())
        assertEquals(1, out.getJSONObject("appState").getInt("zoom"))
        assertTrue(out.has("files"))
    }

    @Test fun eraseSetsDeletedAndBumpsVersion() {
        val scene = Scene.parse(canvas)
        val s = stroke(scene); scene.add(s)
        val v = s.getInt("version"); val nonce = s.getInt("versionNonce")
        scene.erase(s, now = 999L, rnd = Random(1))
        assertTrue(s.getBoolean("isDeleted"))
        assertEquals(v + 1, s.getInt("version"))
        assertNotEquals(nonce, s.getInt("versionNonce"))
        assertEquals(999L, s.getLong("updated"))
        assertEquals(0, scene.liveFreedraws().size)
        // undo 는 복원 + 다시 version 증가
        assertTrue(scene.undo(now = 1000L))
        assertFalse(s.getBoolean("isDeleted"))
        assertEquals(v + 2, s.getInt("version"))
    }

    @Test fun undoOfAddMarksDeletedNotRemoved() {
        val scene = Scene.parse(canvas)
        val s = stroke(scene); scene.add(s)
        scene.undo()
        assertEquals(3, scene.elements.length())
        assertTrue(s.getBoolean("isDeleted"))
    }

    @Test fun freedrawHasFullFieldSetAndRelativePoints() {
        val s = stroke(Scene.parse(""))
        for (k in listOf("id","type","x","y","width","height","angle","strokeColor","backgroundColor","fillStyle",
            "strokeWidth","strokeStyle","roughness","opacity","groupIds","frameId","roundness","seed","version",
            "versionNonce","isDeleted","boundElements","updated","link","locked","index","points","pressures",
            "simulatePressure","lastCommittedPoint")) assertTrue("missing $k", s.has(k))
        assertEquals(10.0, s.getDouble("x"), 0.0); assertEquals(5.0, s.getDouble("y"), 0.0)
        assertEquals(20.0, s.getDouble("width"), 0.0); assertEquals(15.0, s.getDouble("height"), 0.0)
        val p1 = s.getJSONArray("points").getJSONArray(1)
        assertEquals(20.0, p1.getDouble(0), 0.0); assertEquals(0.0, p1.getDouble(1), 0.0)
    }

    @Test fun emptyCanvasDataGivesEmptyScene() {
        assertEquals(0, Scene.parse("").elements.length())
        assertEquals(0, Scene.parse(null).elements.length())
    }

    @Test(expected = Exception::class) fun corruptCanvasDataThrows() { Scene.parse("{not json") }
}
