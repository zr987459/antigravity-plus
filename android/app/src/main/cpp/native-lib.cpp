// 在 App 进程内启动 Node.js（nodejs-mobile），运行网关 server.mjs
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include <cstdio>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/select.h>
#include "node.h"
#include "sha256.h"

static int pipeOut[2];
static int pipeErr[2];

static void *pump(void *arg) {
    int fd = *(int *) arg;
    int prio = (fd == pipeErr[0]) ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(prio, "AGNode", buf);
    }
    return nullptr;
}

static void redirectStdio() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipeOut);
    pipe(pipeErr);
    dup2(pipeOut[1], STDOUT_FILENO);
    dup2(pipeErr[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, pump, &pipeOut[0]);
    pthread_create(&t2, nullptr, pump, &pipeErr[0]);
    pthread_detach(t1);
    pthread_detach(t2);
}

// ---- 防篡改 ----
static bool beingTraced() {
    FILE *f = fopen("/proc/self/status", "r");
    if (!f) return false;
    char line[256]; bool traced = false;
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, "TracerPid:", 10) == 0) { traced = atoi(line + 10) != 0; break; }
    }
    fclose(f);
    return traced;
}

static std::string g_cert, g_hash;

static bool icontains(const char *h, const char *n) {
    size_t nl = strlen(n);
    for (; *h; h++) {
        size_t i = 0;
        while (i < nl && h[i] && tolower((unsigned char) h[i]) == tolower((unsigned char) n[i])) i++;
        if (i == nl) return true;
    }
    return false;
}

// 检测 Frida / Xposed / LSPosed / Substrate 等注入
static bool hooked() {
    FILE *f = fopen("/proc/self/maps", "r");
    if (f) {
        char line[512]; bool bad = false;
        static const char *marks[] = { "frida", "gum-js", "gadget", "XposedBridge", "liblspd", "lsposed", "libriru", "edxp", "libsubstrate", "libsandhook", "libwhale", nullptr };
        while (!bad && fgets(line, sizeof line, f)) {
            for (int i = 0; marks[i]; i++) if (icontains(line, marks[i])) { bad = true; break; }
        }
        fclose(f);
        if (bad) return true;
    }
    // frida-server 默认端口
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s >= 0) {
        sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(27042); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        int fl = fcntl(s, F_GETFL, 0); fcntl(s, F_SETFL, fl | O_NONBLOCK);
        bool open = false;
        if (connect(s, (sockaddr *) &a, sizeof a) == 0) open = true;
        else if (errno == EINPROGRESS) {
            fd_set w; FD_ZERO(&w); FD_SET(s, &w); timeval tv{0, 200000};
            if (select(s + 1, nullptr, &w, nullptr, &tv) == 1) { int err = 0; socklen_t l = sizeof err; getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &l); open = err == 0; }
        }
        close(s);
        if (open) return true;
    }
    return false;
}

// 运行中持续巡检：被调试或被注入就立刻退出（空闲 15s 巡检，降低待机唤醒耗电）
static void *watchdog(void *) {
    for (;;) {
        sleep(15);
        if (beingTraced() || hooked()) { __android_log_write(ANDROID_LOG_ERROR, "AG", "tamper"); _exit(0); }
    }
    return nullptr;
}

static bool checkFiles(const std::string &root) {
    Sha256 sh;
    for (int i = 0; AG_FILES[i]; i++) {
        std::string rel = AG_FILES[i];
        FILE *f = fopen((root + "/" + rel).c_str(), "rb");
        if (!f) return false;
        sh.update(rel.c_str(), rel.size() + 1);
        char b[8192]; size_t n;
        while ((n = fread(b, 1, sizeof b, f)) > 0) sh.update(b, n);
        fclose(f);
    }
    g_hash = sh.hex();
    return g_hash == AG_HASH;
}

static bool checkSignature(JNIEnv *env, jobject ctx) {
    jclass ctxCls = env->GetObjectClass(ctx);
    auto pn = (jstring) env->CallObjectMethod(ctx, env->GetMethodID(ctxCls, "getPackageName", "()Ljava/lang/String;"));
    const char *pnc = env->GetStringUTFChars(pn, nullptr);
    bool pkgOk = strcmp(pnc, AG_PKG) == 0;
    env->ReleaseStringUTFChars(pn, pnc);
    if (!pkgOk) return false;
    jobject pm = env->CallObjectMethod(ctx, env->GetMethodID(ctxCls, "getPackageManager", "()Landroid/content/pm/PackageManager;"));
    jclass pmCls = env->GetObjectClass(pm);
    jobject pi = env->CallObjectMethod(pm, env->GetMethodID(pmCls, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;"), pn, 64);
    if (env->ExceptionCheck()) { env->ExceptionClear(); return false; }
    auto sigs = (jobjectArray) env->GetObjectField(pi, env->GetFieldID(env->GetObjectClass(pi), "signatures", "[Landroid/content/pm/Signature;"));
    if (!sigs || env->GetArrayLength(sigs) != 1) return false;
    jobject s0 = env->GetObjectArrayElement(sigs, 0);
    auto ba = (jbyteArray) env->CallObjectMethod(s0, env->GetMethodID(env->GetObjectClass(s0), "toByteArray", "()[B"));
    jsize len = env->GetArrayLength(ba);
    jbyte *bytes = env->GetByteArrayElements(ba, nullptr);
    Sha256 sh; sh.update(bytes, (size_t) len);
    env->ReleaseByteArrayElements(ba, bytes, JNI_ABORT);
    g_cert = sh.hex();
    return g_cert == AG_CERT;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_antigravity_plus_NodeService_startNode(JNIEnv *env, jobject self, jobjectArray args, jobjectArray envs, jstring rootDir) {
    const char *rd = env->GetStringUTFChars(rootDir, nullptr);
    std::string root(rd);
    env->ReleaseStringUTFChars(rootDir, rd);

    // 环境变量
    jsize envCount = env->GetArrayLength(envs);
    for (jsize i = 0; i < envCount; i++) {
        auto js = (jstring) env->GetObjectArrayElement(envs, i);
        const char *kv = env->GetStringUTFChars(js, nullptr);
        std::string s(kv);
        env->ReleaseStringUTFChars(js, kv);
        size_t eq = s.find('=');
        if (eq == std::string::npos) continue;
        std::string k = s.substr(0, eq);
        setenv(k.c_str(), s.substr(eq + 1).c_str(), 1);
    }
    setenv("LICENSE_MODE", "off", 1);

    std::vector<std::string> parts = { "node", "--max-http-header-size=65536", root + "/src/server.mjs" };
    int argc = (int) parts.size();
    size_t total = 0;
    for (auto &p : parts) total += p.size() + 1;
    char *block = (char *) calloc(total, sizeof(char));
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    char *cur = block;
    for (int i = 0; i < argc; i++) {
        memcpy(cur, parts[i].c_str(), parts[i].size());
        argv[i] = cur;
        cur += parts[i].size() + 1;
    }

    redirectStdio();
    return node::Start(argc, argv);
}
