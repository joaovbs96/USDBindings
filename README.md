# USDBindings

Reproducible WebAssembly build of the OpenUSD + MaterialX SDK and the
[usd-wg-webview](https://github.com/usd-wg/usd-wg-webview) native bindings.

Upstream commits its built `.wasm` by hand and no CI rebuilds it, so the binary
cannot be reproduced from source and the OpenUSD revision it was built against is
not recorded anywhere reliable. This repository pins all three inputs as
submodules and builds them in CI, so every artifact is traceable to exact
revisions.

## Pinned sources

| submodule | path | pin |
|---|---|---|
| OpenUSD | `external/openusd` | `v26.08` |
| MaterialX | `external/materialx` | `v1.39.5` |
| usd-wg-webview | `external/usd-wg-webview` | `b050c373` |

OpenUSD `v26.08` pins MaterialX `v1.39.5` itself, so those two agree by
construction. The webview sources are used **unmodified**.

## Build

```sh
git clone --recursive https://github.com/joaovbs96/USDBindings.git
cd USDBindings
source /path/to/emsdk/emsdk_env.sh     # emsdk_env.bat on Windows
python3 build.py --root ~/usdwasm
```

Output: `~/usdwasm/out/usdWebViewBindingsModule.{js,wasm}`.

Phases are resumable. `--force usd` redoes one, `--clean` resets, and
`--skip-materialx` builds without MaterialX for a faster first pass.

Windows works too, with two caveats. `build_usd.py` auto-selects the Ninja
generator there, so Ninja must be on PATH. It also invokes `emcmake.bat` and
`emmake.bat` by those literal names, while current emsdk ships only `.exe`
launchers (`emcmake.exe`, `emmake.exe`) and `cmd.exe` will not substitute one for
the other. Put `.bat` shims that forward to the `.exe` on PATH ahead of emsdk,
for example:

```bat
@echo off
"C:\path\to\emsdk\upstream\emscripten\emcmake.exe" %*
```

## CI

`.github/workflows/build.yml`, manual dispatch only, since a cold build takes
hours. It records the pinned revisions, measures runner disk before and after
cleanup, watches disk during the build, and uploads the module plus the logs.
On failure it puts the first compile errors directly into the job summary.

The SDK is cached between runs, so only the first run pays the full USD build.
The key comes from `build.py --sdk-fingerprint`, which hashes the OpenUSD and
MaterialX pins together with the text of the functions that build them. So
editing the bindings phase cannot throw away a good SDK, and editing the SDK
phase cannot silently reuse one built with different flags.

A `sdk_cache_bust` checkbox forces a rebuild anyway, for the case where the
cached SDK is suspect rather than stale. It is deliberately not part of the key:
a checkbox only ever produces one value, so the second forced run would restore
the cache the first one wrote. Instead it deletes the entry and skips the
restore, so the rebuild is saved under the same key and becomes the new
baseline. That is also why the job needs `actions: write`.

Compilation is cached separately with ccache, via `EM_COMPILER_WRAPPER`, which
emcc honours for every phase. ccache is content addressed, so a stale entry
cannot be used by mistake: a changed source simply misses. That is why it is the
one cache here restored with `restore-keys`, and why it is saved on every run
regardless of outcome.

Every cache here uses separate restore and save steps, because `actions/cache`
does not save when a job fails, and a failed job is exactly the case worth
caching: a good SDK followed by a broken bindings build, or an emsdk install
that should not be repeated. emsdk is banked as soon as it is set up, the SDK
once its phase marker exists, and ccache unconditionally.

The three together share a 10GB per repository budget, which is why ccache is
capped at 2G: the SDK prefix is the expensive one to lose, and it stays warm
because every run reads it. Before saving, the job deletes `install/build` and `install/src`,
which `build_usd.py` puts inside the install prefix and which are dead weight
once the phase marker says the SDK is done.

## Why MaterialX is built separately

`build_usd.py` force-disables MaterialX on wasm targets:

```python
self.buildMaterialX = args.build_materialx and not self.targetWasm
```

This is a gap in the convenience script, not an incompatibility. OpenUSD's own
CMake has no emscripten guard on `PXR_ENABLE_MATERIALX_SUPPORT`; the script's
MaterialX installer simply has no wasm branch and builds shared libraries, which
cannot link into a static wasm module. So MaterialX is built statically first and
the flag is re-enabled through `--build-args`, whose values land after the
hardcoded `-DPXR_ENABLE_MATERIALX_SUPPORT=OFF` on the same cmake line.

MaterialX inside USD only serves the `usdMtlx` file format plugin, which lets USD
compose `.mtlx` files as layers. Shader compilation happens elsewhere, so a
consumer can render with a different MaterialX build.

## Imaging on wasm

`build_usd.py` refuses the literal argument `--usd-imaging` on wasm targets:

```python
if "--usd-imaging" in sys.argv:
    PrintError("Cannot build Usd Imaging for wasm build targets")
    sys.exit(1)
```

`--imaging` is not on that rejection list, and unlike `--usd-imaging` it survives
the `and not targetWasm` clause that computes `buildImaging`. That distinction
matters for more than the flag: `buildImaging` being true is what adds
**OpenSubdiv** to the dependency list, and no `-D` override can substitute for a
library that never gets built. `PXR_BUILD_USD_IMAGING` is gated off separately,
but it only emits a `-D` flag with no dependencies attached, so `--build-args`
forces it back on.

The bindings need both: they link `libusd_usdImaging.a`,
`libusd_usdSkelImaging.a`, `usdVolImaging`, `usdProcImaging` and `usdHydra`, and
include 12 `usdImaging` headers. Upstream's own `wasm-sdk.md` records
`PXR_BUILD_IMAGING=ON` and `PXR_BUILD_USD_IMAGING=ON` in the SDK they ship, so
this configuration is known to have worked at least once.

## The one OpenUSD source patch

`build.py` patches a single line of `pxr/imaging/hgi/hgi.cpp` before building.
It is applied to the checked-out submodule at build time rather than committed,
so the pin stays exactly `v26.08` and the change is visible in one place.

`_MakeNewPlatformDefaultHgi()` chooses a backend from `ARCH_OS_LINUX`,
`ARCH_OS_DARWIN` or `ARCH_OS_WINDOWS` and otherwise hits `#error Unknown
Platform`. Emscripten gets neither: `arch/defines.h` defines `ARCH_OS_WASM_VM`
in the first `#if`, so the `#elif` that would define `ARCH_OS_LINUX` never runs.
This is the only `#error Unknown Platform` in the whole `pxr` tree, and OpenUSD
`dev` has the identical unfixed code, so it is not a stale-pin problem.

The patch adds an `ARCH_OS_WASM_VM` branch yielding `""`, which is what the
existing `#else` already does: an empty type name finds no plugin, so the
function returns `nullptr` through its own error path. Nothing in this
configuration ever calls it, since every caller is `hdSt` or `hdx` test support
that `PXR_ENABLE_GL_SUPPORT=OFF` excludes. It only has to compile.

The patch refuses to apply if the dispatch is not shaped as expected, so moving
the OpenUSD pin fails loudly instead of silently building something else.

## Finding the SDK's own dependencies from the bindings

The Emscripten toolchain points every `find_*` call at its own sysroot, so a
package built into our install prefix is invisible unless the prefix is named
explicitly. `build_usd.py` hits this too and works around it by setting
`CMAKE_FIND_ROOT_PATH` for its configure, citing emscripten issue 13310.

The installed `pxrConfig.cmake` re-runs `find_dependency` for OpenSubdiv, TBB
and MaterialX, so the bindings configure needs the same treatment. OpenSubdiv is
the one that bites: `Packages.cmake` tries `find_package(OpenSubdiv 3 CONFIG)`
first and, when that succeeds, records `PXR_FIND_OPENSUBDIV_IN_CONFIG=ON` in
`pxrConfig.cmake`, which makes config mode mandatory for every consumer
afterwards. So the bindings configure passes `CMAKE_FIND_ROOT_PATH`,
`CMAKE_PREFIX_PATH` and explicit `OpenSubdiv_DIR` and `MaterialX_DIR`.

## Open questions this repository exists to answer

1. Does `PXR_BUILD_USD_IMAGING=ON` actually compile for wasm? It is gated off in
   `build_usd.py` with no supported escape hatch, which may mean untested rather
   than broken.
2. Do the usd-wg-webview sources compile unmodified against OpenUSD `v26.08`?
   The two fragile includes are `pxr/usd/sdf/usdzResolver.h` (private, not
   installed by the SDK) and `pxr/imaging/hd/unitTestNullRenderPass.h`
   (test support), out of 123 pxr headers.
3. Does a cold build fit a standard GitHub runner's disk and the 6 hour job cap?
4. Does the resulting module behave like the one upstream ships?

## Licences

Each submodule keeps its own: OpenUSD and MaterialX are Apache-2.0,
usd-wg-webview is BSD-3-Clause.
