#!/usr/bin/env python3
"""
Build the OpenUSD + MaterialX WASM SDK and the usd-wg-webview bindings from the
pinned submodules in external/.

    git submodule update --init --recursive
    source /path/to/emsdk/emsdk_env.sh      # emsdk_env.bat on Windows
    python3 build.py --root ~/usdwasm

Produces <root>/out/usdWebViewBindingsModule.{js,wasm}.

Resumable: each phase writes a marker and is skipped on re-run. Use --force
<phase> or --clean to redo work.

Why this is not just `build_usd.py --build-target wasm`:
  build_usd.py force-disables MaterialX for wasm targets
  (buildMaterialX = args.build_materialx and not targetWasm) because its own
  MaterialX installer has no wasm branch and builds shared libraries. OpenUSD
  itself has no emscripten guard on MaterialX, so we build MaterialX statically
  ourselves and re-enable the flag through --build-args, whose values land after
  the hardcoded -DPXR_ENABLE_MATERIALX_SUPPORT=OFF on the same cmake line.
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent
SUBMODULES = {
    "openusd": REPO / "external" / "openusd",
    "materialx": REPO / "external" / "materialx",
    "webview": REPO / "external" / "usd-wg-webview",
}

PHASES = ("materialx", "usd", "bindings")
UPSTREAM_WASM_BYTES = 19733084  # what usd-wg-webview ships, for comparison
IS_WINDOWS = platform.system() == "Windows"


class Ctx:
    def __init__(self, args):
        self.root = Path(args.root).expanduser().resolve()
        self.build = self.root / "build"
        self.install = self.root / "install"      # MaterialX AND USD land here
        self.out = self.root / "out"
        self.logs = self.root / "logs"
        self.markers = self.root / ".phases"
        self.jobs = args.jobs or os.cpu_count() or 4
        self.force = set(PHASES) if args.force_all else set(args.force or [])


def say(msg, kind="info"):
    print("%s %s" % ({"info": "==>", "warn": "!! ", "err": "XX ", "ok": " ok"}[kind], msg),
          flush=True)


def run(cmd, log_path, cwd=None):
    """Run a command, streaming to console and a log file. Raise on failure."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    printable = " ".join(str(c) for c in cmd)
    say(printable[:200] + ("..." if len(printable) > 200 else ""))
    with open(log_path, "a", encoding="utf-8", errors="replace") as log:
        log.write("\n$ %s\n" % printable)
        log.flush()
        proc = subprocess.Popen(
            cmd, cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", bufsize=1,
        )
        for line in proc.stdout:
            sys.stdout.write(line)
            log.write(line)
        proc.wait()
    if proc.returncode != 0:
        raise SystemExit("\nFAILED (exit %d): %s\nLog: %s"
                         % (proc.returncode, printable, log_path))


def which_or_die(tool, hint):
    """Resolve a tool to a full path. Windows CreateProcess does not apply
    PATHEXT, so a bare name like 'emcc' fails even when emcc.exe is on PATH."""
    resolved = shutil.which(tool)
    if not resolved:
        raise SystemExit("Missing '%s' on PATH. %s" % (tool, hint))
    return resolved


def emsdk_hint():
    if IS_WINDOWS:
        return "Run emsdk_env.bat (the .sh variant no-ops outside a POSIX shell)."
    return "Run: source /path/to/emsdk/emsdk_env.sh"


def emcmake_cmd():
    """build_usd.py uses emcmake.bat on Windows and emcmake elsewhere. Resolved
    to a full path because CreateProcess ignores PATHEXT."""
    name = "emcmake.bat" if IS_WINDOWS else "emcmake"
    return shutil.which(name) or name


def check_prereqs():
    for name, path in SUBMODULES.items():
        if not any(path.iterdir()) if path.is_dir() else True:
            raise SystemExit(
                "Submodule '%s' is empty or missing at %s\n"
                "Run: git submodule update --init --recursive" % (name, path))
    which_or_die("git", "Install git.")
    which_or_die("cmake", "Install CMake 3.20+.")
    emcc = which_or_die("emcc", emsdk_hint())
    which_or_die("emcmake.bat" if IS_WINDOWS else "emcmake", emsdk_hint())
    if IS_WINDOWS:
        # build_usd.py defaults Windows wasm builds to Ninja and exits without it,
        # because the Visual Studio generator cannot build emscripten projects.
        # It also invokes emcmake.bat/emmake.bat literally, while current emsdk
        # ships only .exe launchers, so .bat shims must be on PATH ahead of them.
        which_or_die("ninja", "Windows wasm builds need Ninja on PATH.")
        say("Windows host: using emcmake.bat and the Ninja generator", "ok")
    ver = subprocess.run([emcc, "--version"], capture_output=True, text=True)
    blob = (ver.stdout or ver.stderr or "").strip()
    first = blob.splitlines()[0] if blob else "unknown"
    say("emcc: %s" % first, "ok")
    return first


def revisions():
    out = {}
    for name, path in SUBMODULES.items():
        try:
            sha = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"],
                                 capture_output=True, text=True).stdout.strip()
            out[name] = sha[:12] or "unknown"
        except Exception:
            out[name] = "unknown"
    return out


def done(ctx, phase):
    return (ctx.markers / phase).exists() and phase not in ctx.force


def mark(ctx, phase):
    ctx.markers.mkdir(parents=True, exist_ok=True)
    (ctx.markers / phase).write_text(time.strftime("%Y-%m-%d %H:%M:%S"))


def build_materialx(ctx):
    if done(ctx, "materialx"):
        say("materialx: already done, skipping", "ok")
        return
    bld = ctx.build / "materialx"
    # Static, shadergen only. build_usd.py's own installer forces SHARED_LIBS=ON,
    # which cannot link into a static wasm module: that is exactly why it refuses
    # to build MaterialX for wasm at all.
    run([emcmake_cmd(), "cmake", "-S", str(SUBMODULES["materialx"]), "-B", str(bld),
         "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_INSTALL_PREFIX=" + str(ctx.install),
         "-DMATERIALX_BUILD_SHARED_LIBS=OFF",
         "-DMATERIALX_BUILD_GEN_GLSL=ON",
         "-DMATERIALX_BUILD_RENDER=OFF",
         "-DMATERIALX_BUILD_VIEWER=OFF",
         "-DMATERIALX_BUILD_TESTS=OFF",
         "-DMATERIALX_BUILD_DOCS=OFF",
         "-DMATERIALX_BUILD_OIIO=OFF",
         "-DMATERIALX_BUILD_OCIO=OFF",
         "-DMATERIALX_BUILD_JS=OFF",
         "-DMATERIALX_BUILD_PYTHON=OFF"],
        ctx.logs / "materialx.log")
    run(["cmake", "--build", str(bld), "--target", "install", "-j", str(ctx.jobs)],
        ctx.logs / "materialx.log")
    cfg = ctx.install / "lib" / "cmake" / "MaterialX"
    if not cfg.exists():
        raise SystemExit("MaterialX installed but %s is missing." % cfg)
    say("MaterialX config at %s" % cfg, "ok")
    mark(ctx, "materialx")


def build_usd(ctx, with_materialx):
    if done(ctx, "usd"):
        say("usd: already done, skipping", "ok")
        return
    script = SUBMODULES["openusd"] / "build_scripts" / "build_usd.py"
    # --imaging, NOT --usd-imaging: build_usd.py hard-rejects the literal string
    # "--usd-imaging" in sys.argv on wasm targets. --imaging escapes that guard
    # and still pulls OpenSubdiv into requiredDependencies, which a -D flag
    # cannot do. PXR_BUILD_USD_IMAGING is then forced back on below, where it is
    # only a -D flag with no dependencies attached.
    cmd = [sys.executable, str(script),
           "--build-target", "wasm",
           "--imaging",
           "--no-tests", "--no-examples", "--no-tutorials", "--no-docs",
           "--build-args", "USD,-DPXR_BUILD_USD_IMAGING=ON"]
    if with_materialx:
        # MaterialX installs into the same prefix build_usd.py passes as
        # CMAKE_FIND_ROOT_PATH for wasm, so find_package resolves under the
        # emscripten toolchain's restricted lookup. MaterialX_DIR is explicit too.
        mtlx_cfg = ctx.install / "lib" / "cmake" / "MaterialX"
        cmd += ["--build-args", "USD,-DPXR_ENABLE_MATERIALX_SUPPORT=ON",
                "--build-args", "USD,-DMaterialX_DIR=" + str(mtlx_cfg)]
    cmd += ["-j", str(ctx.jobs), str(ctx.install)]
    t0 = time.time()
    run(cmd, ctx.logs / "usd.log")
    say("USD wasm build: %.1f min" % ((time.time() - t0) / 60.0), "ok")
    if with_materialx:
        if (ctx.install / "lib" / "libusd_usdMtlx.a").exists():
            say("libusd_usdMtlx.a present: MaterialX support is in", "ok")
        else:
            say("libusd_usdMtlx.a NOT built: MaterialX did not land. Check the "
                "'MaterialX support' line in logs/usd.log.", "warn")
    mark(ctx, "usd")


def build_bindings(ctx):
    if done(ctx, "bindings"):
        say("bindings: already done, skipping", "ok")
        return
    src = SUBMODULES["webview"] / "native" / "usd-webview-bindings"
    bld = ctx.build / "bindings"
    # USD_WEBVIEW_OPENUSD_SOURCE_DIR must be overridden: upstream defaults it to a
    # path on the maintainer's machine. It needs the OpenUSD *source* tree, for
    # private headers the wasm SDK does not install (e.g. sdf/usdzResolver.h).
    run([emcmake_cmd(), "cmake", "-S", str(src), "-B", str(bld),
         "-DCMAKE_BUILD_TYPE=Release",
         "-Dpxr_DIR=" + str(ctx.install),
         "-DTBB_DIR=" + str(ctx.install / "lib" / "cmake" / "TBB"),
         "-DUSD_WEBVIEW_OPENUSD_SOURCE_DIR=" + str(SUBMODULES["openusd"]),
         "-DCMAKE_INSTALL_PREFIX=" + str(ctx.out)],
        ctx.logs / "bindings.log")
    t0 = time.time()
    run(["cmake", "--build", str(bld), "--target", "install", "-j", str(ctx.jobs)],
        ctx.logs / "bindings.log")
    say("bindings build: %.1f min" % ((time.time() - t0) / 60.0), "ok")
    mark(ctx, "bindings")


def report(ctx, emcc_ver, total_s):
    say("=" * 64)
    say("RESULT")
    wasm = ctx.out / "usdWebViewBindingsModule.wasm"
    glue = ctx.out / "usdWebViewBindingsModule.js"
    for f in (glue, wasm):
        print("   %-40s %s" % (f.name,
              "%d bytes" % f.stat().st_size if f.exists() else "MISSING"))
    if wasm.exists():
        print("   vs upstream %d bytes: %+d"
              % (UPSTREAM_WASM_BYTES, wasm.stat().st_size - UPSTREAM_WASM_BYTES))
    print("   MaterialX in USD:                        %s"
          % ("yes" if (ctx.install / "lib" / "libusd_usdMtlx.a").exists() else "no"))
    print("   emcc:                                    %s" % emcc_ver)
    for name, sha in revisions().items():
        print("   %-40s %s" % (name, sha))
    print("   total wall clock:                        %.1f min" % (total_s / 60.0))
    try:
        size = sum(f.stat().st_size for f in ctx.root.rglob("*") if f.is_file())
        print("   tree size:                               %.1f GB" % (size / 1e9))
        print("   disk free:                               %.1f GB"
              % (shutil.disk_usage(str(ctx.root)).free / 1e9))
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(
        description="Build the OpenUSD + MaterialX WASM SDK and the usd-wg-webview bindings.")
    ap.add_argument("--root", default="~/usdwasm", help="working directory (default: ~/usdwasm)")
    ap.add_argument("-j", "--jobs", type=int, default=None, help="parallel jobs")
    ap.add_argument("--force", action="append", choices=PHASES, help="redo a phase (repeatable)")
    ap.add_argument("--force-all", action="store_true", help="redo every phase")
    ap.add_argument("--clean", action="store_true", help="delete build/, out/ and markers first")
    ap.add_argument("--skip-materialx", action="store_true",
                    help="build USD without MaterialX (breaks .mtlx layer references)")
    args = ap.parse_args()

    ctx = Ctx(args)
    emcc_ver = check_prereqs()
    ctx.root.mkdir(parents=True, exist_ok=True)
    if args.clean:
        for d in (ctx.build, ctx.out, ctx.markers):
            if d.exists():
                shutil.rmtree(d)
        say("cleaned build/, out/, markers", "ok")

    say("root: %s   jobs: %d" % (ctx.root, ctx.jobs))
    for name, sha in revisions().items():
        say("%-16s %s" % (name, sha))
    t0 = time.time()
    if args.skip_materialx:
        say("skipping MaterialX: .mtlx layer references will not compose", "warn")
        mark(ctx, "materialx")
    else:
        build_materialx(ctx)
    build_usd(ctx, with_materialx=not args.skip_materialx)
    build_bindings(ctx)
    report(ctx, emcc_ver, time.time() - t0)


if __name__ == "__main__":
    main()
