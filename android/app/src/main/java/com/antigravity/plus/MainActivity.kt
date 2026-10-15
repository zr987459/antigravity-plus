package com.antigravity.plus

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Antigravity Gateway 独立版
 * 网关跑在手机本地（NodeService），这里用 WebView 打开本地控制台。
 * 右上角菜单「服务器设置」可改端口、生成密钥、开关悬浮球。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var cover: TextView
    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private var failed = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        prefs.apiKey // 先在这里生成密钥，再启动网关，两边一定一致
        prefs.gatewayOn = true
        startGatewayService()

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#07090C"))
        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#07090C"))
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))

        cover = TextView(this).apply {
            text = "网关启动中…"
            setTextColor(Color.parseColor("#8FA3B8"))
            textSize = 14f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#07090C"))
        }
        root.addView(cover, FrameLayout.LayoutParams(-1, -1))

        val s: WebSettings = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        WebView.setWebContentsDebuggingEnabled(false)
        s.cacheMode = WebSettings.LOAD_NO_CACHE
        s.userAgentString = s.userAgentString + " AntigravityGatewayApp/4.0"
        webView.addJavascriptInterface(Bridge(), "AGApp")
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val host = uri.host ?: ""
                if ((host == "127.0.0.1" || host == "localhost") && uri.port == prefs.port) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (e: Exception) {}
                return true
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                if (!failed) cover.visibility = View.GONE
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    failed = true
                    cover.visibility = View.VISIBLE
                    handler.postDelayed({ load() }, 1500)
                }
            }
        }
        setContentView(root)
        load()
        if (!prefs.askedPerms) { prefs.askedPerms = true; askPermissions() }
        else if (prefs.autoUpdate) handler.postDelayed({ Updater.check(this, false) }, 3000)
    }

    private fun load() {
        failed = false
        webView.loadUrl("http://127.0.0.1:${prefs.port}/?app=1")
    }

    private fun startGatewayService() {
        val i = Intent(this, NodeService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
    }

    private fun restartGateway() {
        cover.text = "网关重启中…"
        cover.visibility = View.VISIBLE
        stopService(Intent(this, NodeService::class.java))
        handler.postDelayed({ startGatewayService(); handler.postDelayed({ load() }, 1500) }, 1200)
    }

    private fun askPermissions() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (Build.VERSION.SDK_INT >= 23) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) } catch (e: Exception) {}
            }
        }
    }

    private fun openOverlaySettings() {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) } catch (e: Exception) {}
        }
    }

    private fun showSettings() {
        val d = resources.displayMetrics.density
        val pad = (18 * d).toInt()
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad / 2, pad, 0) }

        box.addView(TextView(this).apply { text = "端口" })
        val portInput = EditText(this).apply {
            setText(prefs.port.toString()); inputType = InputType.TYPE_CLASS_NUMBER; setSingleLine(true)
        }
        box.addView(portInput)

        box.addView(TextView(this).apply { text = "密钥（客户端填 API Key，也用来登录控制台）"; setPadding(0, pad / 2, 0, 0) })
        val keyInput = EditText(this).apply { setText(prefs.apiKey); setSingleLine(true) }
        box.addView(keyInput)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Button(this).apply { text = "随机生成"; setOnClickListener { keyInput.setText(Prefs.newKey()) } }, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(Button(this).apply {
            text = "复制"
            setOnClickListener {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("key", keyInput.text.toString()))
                Toast.makeText(this@MainActivity, "已复制", Toast.LENGTH_SHORT).show()
            }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        box.addView(row)

        val sw = Switch(this).apply {
            text = "悬浮球（防止后台被杀）"
            isChecked = prefs.bubble
            setPadding(0, pad / 2, 0, 0)
        }
        box.addView(sw)

        val swUp = Switch(this).apply {
            text = "自动检查更新"
            isChecked = prefs.autoUpdate
            setPadding(0, pad / 2, 0, 0)
        }
        box.addView(swUp)
        box.addView(Button(this).apply {
            text = "检查更新（当前 ${BuildConfig.VERSION_NAME}）"
            setOnClickListener { Updater.check(this@MainActivity, true) }
        })

        AlertDialog.Builder(this)
            .setTitle("网关设置")
            .setView(android.widget.ScrollView(this).apply { addView(box) })
            .setPositiveButton("保存并重启") { _, _ ->
                val port = portInput.text.toString().trim().toIntOrNull()
                if (port == null || port < 1024 || port > 65535 || port == 51121) {
                    Toast.makeText(this, "端口要在 1024–65535 之间（51121 被授权占用）", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                val key = keyInput.text.toString().trim()
                if (key.length < 8) {
                    Toast.makeText(this, "密钥至少 8 位", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                prefs.autoUpdate = swUp.isChecked
                val changed = port != prefs.port || key != prefs.apiKey
                prefs.port = port
                prefs.apiKey = key
                prefs.bubble = sw.isChecked
                if (sw.isChecked) openOverlaySettings()
                if (changed) restartGateway() else startGatewayService()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showHarkLoginDialog() {
        val dialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen).create()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#07090C"))
        }

        // 顶部操作栏
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#0F141A"))
            val pad = (12 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.CENTER_VERTICAL
        }

        val closeBtn = Button(this).apply {
            text = "✕ 关闭"
            setTextColor(Color.parseColor("#C3D2D6"))
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { dialog.dismiss() }
        }
        topBar.addView(closeBtn)

        val title = TextView(this).apply {
            text = "登录 Hark.com (免抓包)"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
        }
        topBar.addView(title)

        val extractBtn = Button(this).apply {
            text = "提取保存"
            setTextColor(Color.parseColor("#001318"))
            setBackgroundColor(Color.parseColor("#00E5FF"))
        }
        topBar.addView(extractBtn)
        layout.addView(topBar)

        val loginWeb = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(-1, -1)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36"
        }
        layout.addView(loginWeb)

        fun doExtract() {
            val cm = CookieManager.getInstance()
            val cookie = cm.getCookie("https://hark.com") ?: ""
            if (cookie.contains("session_token") || cookie.length > 20) {
                Toast.makeText(this@MainActivity, "成功提取 Hark Cookie！", Toast.LENGTH_SHORT).show()
                val encoded = Uri.encode(cookie)
                webView.evaluateJavascript("window.onHarkCookieCaptured && window.onHarkCookieCaptured(decodeURIComponent('$encoded'))", null)
                dialog.dismiss()
            } else {
                Toast.makeText(this@MainActivity, "未检测到有效 Cookie，请先在页面中登录 Hark 账号", Toast.LENGTH_LONG).show()
            }
        }

        extractBtn.setOnClickListener { doExtract() }

        loginWeb.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                val cm = CookieManager.getInstance()
                val cookie = cm.getCookie("https://hark.com") ?: ""
                if (cookie.contains("session_token=")) {
                    title.text = "✓ 已登录 (点右上角保存)"
                    title.setTextColor(Color.parseColor("#3DFF9A"))
                }
            }
        }

        loginWeb.loadUrl("https://hark.com/chat")
        dialog.setView(layout)
        dialog.show()
    }

    override fun onResume() {
        super.onResume()
        if (prefs.gatewayOn) startGatewayService() // 刷新悬浮球状态
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) { webView.goBack(); return true }
        if (keyCode == KeyEvent.KEYCODE_BACK) { moveTaskToBack(true); return true } // 返回键不退出，网关继续跑
        return super.onKeyDown(keyCode, event)
    }

    inner class Bridge {
        @JavascriptInterface fun openSettings() { runOnUiThread { showSettings() } }
        @JavascriptInterface fun openHarkLogin() { runOnUiThread { showHarkLoginDialog() } }
        @JavascriptInterface fun adminKey(): String = prefs.apiKey
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun startGateway() { runOnUiThread { prefs.gatewayOn = true; restartGateway() } }
        @JavascriptInterface fun stopGateway() { runOnUiThread { prefs.gatewayOn = false; stopService(Intent(this@MainActivity, NodeService::class.java)) } }
        @JavascriptInterface fun port(): Int = prefs.port
        @JavascriptInterface fun setPort(p: Int): Boolean {
            if (p !in 1024..65535) return false
            runOnUiThread { if (p != prefs.port) { prefs.port = p; prefs.gatewayOn = true; restartGateway() } }
            return true
        }
        @JavascriptInterface fun regenKey() {
            runOnUiThread { prefs.apiKey = Prefs.newKey(); prefs.gatewayOn = true; restartGateway() }
        }
        @JavascriptInterface fun isBubble(): Boolean = prefs.bubble
        @JavascriptInterface fun setBubble(on: Boolean, running: Boolean) {
            runOnUiThread {
                prefs.bubble = on
                if (on && Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this@MainActivity)) {
                    Toast.makeText(this@MainActivity, "请允许「显示在其他应用上层」，然后回来再开一次", Toast.LENGTH_LONG).show()
                    try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) } catch (e: Exception) {}
                    return@runOnUiThread
                }
                if (running) startGatewayService()
            }
        }
        @JavascriptInterface fun checkUpdate() { runOnUiThread { Updater.check(this@MainActivity, true) } }
    }
}
