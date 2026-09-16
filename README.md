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

Windows works too: `build_usd.py` calls `emcmake.bat`/`emmake.bat` there and
auto-selects the Ninja generator, so Ninja must be on PATH.

## CI

`.github/workflows/build.yml`, manual dispatch only, since a cold build takes
hours. It records the pinned revisions, measures runner disk before and after
cleanup, watches disk during the build, and uploads the module plus the logs.
On failure it puts the first compile errors directly into the job summary.

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

## Open questions this repository exists to answer

1. Do the usd-wg-webview sources compile unmodified against OpenUSD `v26.08`?
   The two fragile includes are `pxr/usd/sdf/usdzResolver.h` (private, not
   installed by the SDK) and `pxr/imaging/hd/unitTestNullRenderPass.h`
   (test support), out of 123 pxr headers.
2. Does a cold build fit a standard GitHub runner's disk and the 6 hour job cap?
3. Does the resulting module behave like the one upstream ships?

## Licences

Each submodule keeps its own: OpenUSD and MaterialX are Apache-2.0,
usd-wg-webview is BSD-3-Clause.
