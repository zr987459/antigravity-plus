package com.antigravity.plus

import android.app.Activity
import android.widget.Toast

/**
 * 检查更新：本地独立运行版本，无第三方服务器依赖
 */
object Updater {
    fun check(act: Activity, manual: Boolean) {
        if (manual) {
            Toast.makeText(act, "当前已是最新独立版 v${BuildConfig.VERSION_NAME} (Gemini Web 直驱)", Toast.LENGTH_SHORT).show()
        }
    }
}
