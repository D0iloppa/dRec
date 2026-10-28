package me.doil.drec.eink

import android.app.Application
import android.os.Build
import org.lsposed.hiddenapibypass.HiddenApiBypass

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Onyx Pen SDK 가 숨은 API 를 리플렉션으로 사용한다 (SDK 샘플과 동일).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try { HiddenApiBypass.addHiddenApiExemptions("") } catch (_: Throwable) {}
        }
    }
}
