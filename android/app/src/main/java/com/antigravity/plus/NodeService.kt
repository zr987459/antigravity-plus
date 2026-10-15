package com.antigravity.plus

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * 网关常驻服务（独立进程 :node）
 * - 在手机本地启动 Node.js 跑网关（端口、密钥来自设置）
 * - 前台通知 + WakeLock 防止后台被杀
 * - 悬浮球：可拖动、自动贴边，点一下回到 App
 */
class NodeService : Service() {

    companion object {
        const val CHANNEL_ID = "ag_gateway"
        const val NOTIFY_ID = 8792
        @Volatile var started = false

        init {
            System.loadLibrary("node")
            System.loadLibrary("native-lib")
        }
    }

    external fun startNode(args: Array<String>, envs: Array<String>, rootDir: String): Int

    private var wakeLock: PowerManager.WakeLock? = null
    private var wm: WindowManager? = null
    private var bubble: TextView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("WakelockTimeout")
    override fun onCreate() {
        super.onCreate()
        createChannel()
        val prefs = Prefs(this)
        val n = buildNotification(prefs.port)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFY_ID, n)
        }
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Antigravity::Gateway")
            wakeLock?.acquire()
        } catch (e: Exception) {}
        startGateway(prefs)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Prefs(this).bubble && canOverlay()) showBubble() else hideBubble()
        return START_STICKY
    }

    private fun startGateway(prefs: Prefs) {
        if (started) return
        started = true
        val root = File(filesDir, "gateway")
        AssetCopier.sync(this, root)
        val script = File(root, "src/server.mjs").absolutePath
        val envs = arrayOf(
            "PORT=${prefs.port}",
            "ADMIN_KEY=${prefs.apiKey}",
            "NODE_ENV=production",
            "APP_VERSION=${BuildConfig.VERSION_NAME}",
            "AG_DEVICE=${deviceId()}",
            "HOME=${filesDir.absolutePath}",
            "TMPDIR=${cacheDir.absolutePath}"
        )
        Thread({
            try {
                val rc = startNode(arrayOf("node", script), envs, root.absolutePath)
                if (rc == -100) {
                    val nm = getSystemService(NotificationManager::class.java)
                    nm.notify(NOTIFY_ID, NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle("安装包校验失败")
                        .setContentText("请重新下载官方版本")
                        .setSmallIcon(android.R.drawable.stat_notify_error)
                        .build())
                }
            } catch (e: Throwable) {
                android.util.Log.e("AGNode", "node exited", e)
            }
        }, "node-main").apply { isDaemon = false; start() }
    }

    @SuppressLint("HardwareIds")
    private fun deviceId(): String {
        val raw = (Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "")
        val d = java.security.MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
        return d.joinToString("") { "%02x".format(it) }.substring(0, 32)
    }

    private fun canOverlay() = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)

    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble() {
        if (bubble != null) return
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val d = resources.displayMetrics.density
        val size = (46 * d).toInt()
        val view = TextView(this).apply {
            text = "AG"
            setTextColor(Color.parseColor("#07090C"))
            textSize = 13f
            gravity = Gravity.CENTER
            paint.isFakeBoldText = true
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#00E5FF"))
                setStroke((2 * d).toInt(), Color.parseColor("#07090C"))
            }
            alpha = 0.85f
        }
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                   else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val lp = WindowManager.LayoutParams(size, size, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = (resources.displayMetrics.heightPixels * 0.35).toInt()
        }
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var moved = false
        view.setOnTouchListener { v, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    tuckHandler.removeCallbacksAndMessages(null)
                    val w = resources.displayMetrics.widthPixels
                    if (lp.x < 0) lp.x = 0 else if (lp.x > w - size) lp.x = w - size
                    try { wm?.updateViewLayout(v, lp) } catch (ex: Exception) {}
                    downX = e.rawX; downY = e.rawY; startX = lp.x; startY = lp.y; moved = false; v.alpha = 1f
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (Math.abs(dx) > 8 * d || Math.abs(dy) > 8 * d) moved = true
                    lp.x = startX + dx.toInt(); lp.y = startY + dy.toInt()
                    wm?.updateViewLayout(v, lp)
                }
                MotionEvent.ACTION_UP -> {
                    val w = resources.displayMetrics.widthPixels
                    if (!moved) {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                    }
                    lp.x = if (lp.x + size / 2 < w / 2) 0 else w - size
                    try { wm?.updateViewLayout(v, lp) } catch (ex: Exception) {}
                    scheduleTuck(v, lp, size)
                }
            }
            true
        }
        try { wm?.addView(view, lp); bubble = view; scheduleTuck(view, lp, size) } catch (e: Exception) {}
    }

    private val tuckHandler = android.os.Handler(android.os.Looper.getMainLooper())

    /** 停 2.5 秒后缩到屏幕边上，只露一半、半透明，不挡内容 */
    private fun scheduleTuck(v: View, lp: WindowManager.LayoutParams, size: Int) {
        tuckHandler.removeCallbacksAndMessages(null)
        tuckHandler.postDelayed({
            if (bubble !== v) return@postDelayed
            val w = resources.displayMetrics.widthPixels
            lp.x = if (lp.x + size / 2 < w / 2) -size / 2 else w - size / 2
            v.alpha = 0.45f
            try { wm?.updateViewLayout(v, lp) } catch (e: Exception) {}
        }, 2500)
    }

    private fun hideBubble() {
        tuckHandler.removeCallbacksAndMessages(null)
        bubble?.let { try { wm?.removeView(it) } catch (e: Exception) {} }
        bubble = null
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL_ID, "网关运行中", NotificationManager.IMPORTANCE_LOW)
            ch.description = "保持本地网关在后台运行"
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(port: Int): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Antigravity 网关运行中")
            .setContentText("http://127.0.0.1:$port")
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    override fun onDestroy() {
        hideBubble()
        try { wakeLock?.release() } catch (e: Exception) {}
        super.onDestroy()
        // Node 无法在同一进程里重启：结束本进程，下次启动服务会用新端口/密钥
        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
