// 在 App 进程内启动 Node.js（nodejs-mobile），运行网关 server.mjs
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include <cstdio>
#include "node.h"

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
        __android_log_write(prio, "AGPlusNode", buf);
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
