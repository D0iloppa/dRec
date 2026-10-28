package me.doil.drec.eink

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** dRec 캔버스 API. 호출은 반드시 백그라운드 스레드에서. 실패는 IOException. */
object CanvasApi {
    const val BASE = "https://drec.doil.me"

    /** canvas_data 문자열(없으면 빈 문자열). */
    fun load(meetingId: Int, token: String): String {
        val c = open(meetingId, token, "GET")
        try {
            val body = readOrThrow(c)
            val o = JSONObject(body)
            return if (o.isNull("canvas_data")) "" else o.getString("canvas_data")
        } finally { c.disconnect() }
    }

    fun save(meetingId: Int, token: String, json: String) {
        val c = open(meetingId, token, "PUT")
        try {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            c.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            readOrThrow(c)
        } finally { c.disconnect() }
    }

    private fun open(id: Int, token: String, method: String): HttpURLConnection =
        (URL("$BASE/api/meetings/$id/canvas").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 20_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
        }

    private fun readOrThrow(c: HttpURLConnection): String {
        val code = c.responseCode
        if (code !in 200..299) throw IOException("HTTP $code")
        return c.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }
}
