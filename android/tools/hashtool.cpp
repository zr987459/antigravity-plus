// CI 用：用和 App 内完全相同的 SHA-256 代码算校验值
// hashtool test            -> sha256("abc")
// hashtool raw <file>      -> sha256(file)
// hashtool files <root> <rel...> -> 与 native-lib.cpp checkFiles 相同的组合哈希
#include <cstdio>
#include <string>
#include "sha256.h"
static bool feed(Sha256 &sh, const std::string &path) {
    FILE *f = fopen(path.c_str(), "rb"); if (!f) return false;
    char b[8192]; size_t n; while ((n = fread(b, 1, sizeof b, f)) > 0) sh.update(b, n); fclose(f); return true;
}
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    std::string cmd = argv[1];
    Sha256 sh;
    if (cmd == "test") { sh.update("abc", 3); }
    else if (cmd == "raw" && argc == 3) { if (!feed(sh, argv[2])) return 1; }
    else if (cmd == "files" && argc >= 3) {
        std::string root = argv[2];
        for (int i = 3; i < argc; i++) { std::string rel = argv[i]; sh.update(rel.c_str(), rel.size() + 1); if (!feed(sh, root + "/" + rel)) return 1; }
    } else return 2;
    printf("%s\n", sh.hex().c_str());
    return 0;
}
