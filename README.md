# Antigravity+ (Google Gemini Web2API 网页版直驱网关)

专为手机 Android 与本地环境打造的 **Antigravity 增强版网关**。
核心特性：直接联动 **CookieBox** 提取的 Google 账号 Cookie，免 API Key、免授权码、免第三方中转，100% 本地纯净运行。

---

## 🌟 核心特性

1. **Google Gemini 官方网页版直驱 (Web2API)**：
   - 直接支持通过 CookieBox 导出的 Google Cookie (`SAPISID`, `__Secure-1PSID`, `__Secure-1PSIDTS`) 进行原生免 Key 调用。
   - 内置 **XSRF 令牌自愈心跳**：当 Google 轮换令牌时自动捕获新令牌并静默重试，永不掉线。
2. **OpenAI 与 Anthropic 双标准协议**：
   - `/v1/chat/completions` (OpenAI 协议，秒级流式打字机)
   - `/v1/messages` (Anthropic 协议，完美兼容 Pi 编码代理、Claude 插件等)
3. **完全无授权码 / 纯净开源**：
   - 彻底删除一切商业授权码、激活限制与外部锁，完全本地自主运行。
4. **双 App 完美共存**：
   - 独立包名：`com.antigravity.plus`
   - 独立端口：`8792`（完全避开原版 Antigravity 的 `8790`）
   - 两款 App 在手机上可以同时安装、同时运行、互不影响。
5. **Android 原生保活与悬浮球**：
   - 前台服务常驻，防止系统杀后台；桌面便捷磁吸小球，点一下秒回控制台。

---

## 🚀 支持模型

| 模型 ID | 说明 | 特点 |
| :--- | :--- | :--- |
| `gemini-web-flash` | Google Gemini 网页版极速模型 | 秒出字、高并发、免 Key |
| `gemini-web-thinking` | Google Gemini 网页版深度思考模式 | 具备完整推理链、复杂逻辑解题 |
| `gemini-2.5-pro` | Google 原生 Pro 旗舰 | 百万上下文、代码生成最强 |
| `gemini-2.5-flash` | Google Flash 高效模型 | 轻量敏捷 |
| `claude-3-7-sonnet` | Claude 3.7 Sonnet | 混合推理、代码与复杂工程架构 |

---

## 📱 客户端接入示例

### OpenAI 兼容接入
- **Base URL**: `http://127.0.0.1:8792/v1`
- **API Key**: 任意字符（免密钥模式）
- **Model**: `gemini-web-flash`

### Anthropic 兼容接入
- **Base URL**: `http://127.0.0.1:8792`
- **Header**: `x-api-key: any`
- **Model**: `gemini-web-flash`
