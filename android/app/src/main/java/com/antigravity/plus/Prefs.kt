package com.antigravity.plus

import android.content.Context
import java.io.File
import java.security.SecureRandom
import java.util.Properties

/**
 * 本地设置：端口、密钥、悬浮球开关。
 * 存成普通文件、每次都从磁盘读，保证 App 进程和网关进程(:node)看到的是同一份。
 */
class Prefs(ctx: Context) {
    private val file = File(ctx.filesDir, "ag_config.properties")

    @Synchronized private fun load(): Properties {
        val p = Properties()
        if (file.exists()) file.inputStream().use { p.load(it) }
        return p
    }

    @Synchronized private fun put(k: String, v: String) {
        val p = load()
        p.setProperty(k, v)
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.outputStream().use { p.store(it, null) }
        tmp.renameTo(file)
    }

    var port: Int
        get() = load().getProperty("port")?.toIntOrNull() ?: 8792
        set(v) = put("port", v.toString())

    var apiKey: String
        get() {
            val k = load().getProperty("api_key")
            if (!k.isNullOrEmpty()) return k
            val n = newKey()
            put("api_key", n)
            return n
        }
        set(v) = put("api_key", v)

    var bubble: Boolean
        get() = load().getProperty("bubble", "true") == "true"
        set(v) = put("bubble", v.toString())

    var autoUpdate: Boolean
        get() = load().getProperty("auto_update", "true") == "true"
        set(v) = put("auto_update", v.toString())

    var gatewayOn: Boolean
        get() = load().getProperty("gateway_on", "true") == "true"
        set(v) = put("gateway_on", v.toString())

    var askedPerms: Boolean
        get() = load().getProperty("asked_perms") == "true"
        set(v) = put("asked_perms", v.toString())

    companion object {
        fun newKey(): String {
            val chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            val r = SecureRandom()
            return "sk-ag-" + (1..24).map { chars[r.nextInt(chars.length)] }.joinToString("")
        }
    }
}
