# USDBindings

Reproducible WebAssembly build of the OpenUSD + MaterialX SDK and the
[usd-wg-webview](https://github.com/usd-wg/usd-wg-webview) native bindings,
with a small set of local patches applied on top.

Upstream commits its built `.wasm` by hand and no CI rebuilds it, so the
binary cannot be reproduced from source and the OpenUSD revision it was built
against is not recorded anywhere reliable. This repository pins all three
inputs as submodules, applies the patches below, and builds in CI, so every
artifact is traceable to exact revisions and to the exact source changes it
carries.

## Overview

The build produces three files: `usdWebViewBindingsModule.js` (the Emscripten
glue), `usdWebViewBindingsModule.wasm` (the compiled module), and the
unmodified `usdWebViewBindings.js` wrapper from usd-wg-webview that loads
them. All three are consumed by the MaterialXNodeDocs USD Scene viewer, which
vendors them under `vendor/usd-webview-bindings/` and drives the module from
`js/usd/usd-stage-worker.js`. That worker calls `InitializeRuntime`,
`OpenStage`, `ExtractMaterialPayloads` and `ExtractTransformsAtTime` (and a
scene-graph query) against the loaded module; `js/usd-scene-renderer.js`
consumes the resulting payloads and, separately, still re-derives camera
transforms in JavaScript rather than through the new scene-transform patch,
so that patch's benefit is not yet wired into the renderer.

The artifact reaches that consumer through two paths, and they currently
disagree. A **pinned upstream fetch** (`scripts/vendor.mjs`) downloads the
three files straight from the `usd-wg-webview` repository at commit
`b050c3731d1854a5980b6b4fe55ec1725dc18f51` and checks them against recorded
sha256 hashes; this path still points at unpatched upstream sources. A
**local install** of a verified artifact built from this repository
(`scratchpad/install-approved-usd-bindings.ps1` in the consumer repo) carries
the patches described below. The Publishing and Verification record sections
cover what closing that gap requires.

## Upstream sources

| submodule | path | recorded commit |
|---|---|---|
| OpenUSD | `external/openusd` | `ee47c679abde5b467a7b6a41f3b2285564a4222e` (`v26.08`) |
| MaterialX | `external/materialx` | `7b64921ef1d42f2d57871e9d2c43dc11f041f26b` (`git describe`: `v1.39.5-rc1-25-g7b64921e`, i.e. 25 commits past the `v1.39.5-rc1` tag, not the `v1.39.5` tag itself) |
| usd-wg-webview | `external/usd-wg-webview` | `b050c3731d1854a5980b6b4fe55ec1725dc18f51` (`main`) |

From OpenUSD, the build turns on Imaging and MaterialX support and turns GL
off: `--imaging` (which pulls in OpenSubdiv, unlike the rejected
`--usd-imaging` flag), `-DPXR_BUILD_USD_IMAGING=ON`,
`-DPXR_ENABLE_MATERIALX_SUPPORT=ON`, `-DPXR_ENABLE_GL_SUPPORT=OFF`, and
`-DBUILD_SHARED_LIBS=OFF` for OpenSubdiv specifically; the Building on Windows
section explains why the last one is load-bearing. MaterialX itself is built
as a separate, static, shadergen-only phase (`MATERIALX_BUILD_RENDER=OFF`,
`MATERIALX_BUILD_VIEWER=OFF`, no Python/JS bindings) because `build_usd.py`
force-disables MaterialX on wasm targets and its own installer only knows how
to build shared libraries.

From usd-wg-webview, the build compiles the native `usd-webview-bindings`
C++ sources (JavaScript/Emscripten glue and the inline MaterialX exporter)
against the SDK above. Several of these sources are now patched locally, so
unlike the OpenUSD-side changes they are no longer used unmodified; the Local
patches section covers each one.

## Local patches

All patches live in `patches/` as `.cpp.in`/`.cmake.in` templates. `build.py`
applies each one to the checked-out submodule at build time (never committed
into the submodule), and every application site asserts its anchor text
matches exactly once before writing, so a moved upstream pin fails the build
instead of silently patching the wrong thing. They are listed in the order
the underlying defects were fixed.

**Material interface values and NodeGraph forwarding**
(`emit-material-interface-values.cpp.in`, target
`native/usd-webview-bindings/src/materials.cpp`, function
`_AppendMtlxInputXml`). The original connection walk stopped at the first
`UsdShadeShader` prim, so a shader input connected to an authored `Material`
or `NodeGraph` interface input found no shader and the generated MaterialX
input simply disappeared. In the viewer this showed up as interface defaults
(for example a material's base color set at the Material/NodeGraph level
rather than on the shader) rendering as the MaterialX node's black or zero
default. The fix walks `UsdShadeInput::GetValueProducingAttributes()`,
OpenUSD's own shading-network resolver, which also handles nested
NodeGraphs, cycles, and invalid sources. Covered by
`tests/material-interface-inline.mjs` (color, float, and vector cases).

**Texcoord connection preservation** (`preserve-material-texcoord.cpp.in`,
same file/function). The serializer discarded every input literally named
`texcoord`, including authored values and connections, so any material that
connected or overrode `texcoord` lost that input entirely, falling back to a
node definition's implicit UV default even when the author had wired
something else. The fix lets `texcoord` use the normal value-producing path;
inputs with no authored payload are still omitted so the implicit default
still applies when nothing was authored. Covered by
`tests/material-texcoord-inline.mjs` (connected, literal, and implicit
cases, checked for no duplicate inputs).

**Evaluating transforms and material values at stage start time**
(`evaluate-material-values-at-stage-start.cpp.in`, same file/function, plus
the general default-time behavior it replaces). Values were read with
`Get(&value)` at the USD default time, which does not see time-sampled
attributes. The fix reads at `stage->GetStartTimeCode()` instead, so a
default-only attribute still resolves at any numeric time and a
time-sampled one picks up the value authored at the stage's own opening
frame instead of nothing. This is exercised together with the interface-value
fix's resolver, and specifically by `tests/material-time-samples-inline.mjs`.

**Scene transform emission** (`emit-scene-transforms.cpp.in`, target
`native/usd-webview-bindings/src/stageApi.cpp`, function
`ExtractTransformsAtTime`, plus a header include added to
`webviewCommon.h`). The function only emitted `UsdGeomMesh` transforms, so
the JavaScript side had no time-sampled camera or light matrices to read,
since default-time attribute reads cannot see time samples either. The
additive patch keeps every existing mesh record and adds `UsdGeomCamera` and
`UsdLuxLightAPI` prims in the same `{path, matrix}` shape. Covered by
`tests/time-sampled-scene-transforms.mjs` (two time samples across a Mesh, a
Camera, and a DomeLight, with an unrelated Xform confirmed excluded).

**The contextual displacement terminal**
(`emit-material-displacement-terminal.cpp.in`, same file, around
`_FindInlineMaterialXSurfaceShaderPrim`/`_FindInlineMaterialXTerminalShaderPrim`,
plus edits to the shader-output type mapping and the `<surfacematerial>`
emission). Previously only a hard-coded `surfaceshader` terminal was
emitted, and the terminal-shader lookup picked a shader by traversal order
rather than by following the authored `outputs:mtlx:*` connection. The fix
generalizes the lookup into `_FindInlineMaterialXTerminalShaderPrim`, used
for both `surface` and `displacement`, follows the authored output
connection first (falling back to a `ND_`-prefixed shader on a
matching-suffix output), types the new terminal's `outputType` as
`displacementshader` for the `displacement` category (previously mistyped
as `float`), and emits a `<input name="displacementshader" ...>` on the
`<surfacematerial>` only when a displacement shader was actually found; an
unconnected or absent displacement output is not guessed at, and a
deliberately unrelated ("orphan") displacement prim in a scene is not
picked up by traversal order. Covered by
`tests/material-displacement-terminal-inline.mjs`, which asserts the
connected displacement shader is used and explicitly asserts the orphan is
not.

**Static OpenSubdiv link configuration**
(`configure-bindings-link.cmake.in`, target
`native/usd-webview-bindings/CMakeLists.txt`). This one is not a
source-behavior fix but a link-configuration one: it redirects
`OpenSubdiv::osdCPU` to the installed static archive even if a reused SDK
prefix still has stale shared OpenSubdiv files beside it, and separately
exposes `USD_WEBVIEW_LINK_OPTIMIZATION` as a cache variable so the bindings
link step's optimization level can be overridden, as used in Building on
Windows. This patch has no dedicated fixture; it is verified indirectly by
the static-link checks described there and by every other fixture actually
loading the module.

Two more changes are applied outside the webview patches proper. A single
OpenUSD source change (`pxr/imaging/hgi/hgi.cpp`) adds an
`ARCH_OS_WASM_VM` branch to `_MakeNewPlatformDefaultHgi()`'s platform
dispatch, without which the file does not compile under Emscripten (`#error
Unknown Platform`). And the geomprop-streaming patch to `unifiedDriver.cpp`
(`expand-float-primvar.cpp.in` + `emit-geomprops.cpp.in`) lets
`geompropvalue` MaterialX nodes read any scalar or vector primvar, not only
`st` and `normals`. Neither has a dedicated fixture in `tests/`; the geomprop
patch's own anchors are asserted to match exactly once, but there is no
automated test exercising its behavior.

## Building on Windows

This machine already has: emsdk `6.0.8` (checked-out at
`C:\Users\joaov\emsdk`, `.emsdk_version` reports `"6.0.8"`), CMake `3.31.4`,
Python `3.11.9`, Ninja on PATH, and a working build root at
`C:\Users\joaov\usdwasm` (with an `install/` prefix, `out/` output directory,
and several previously verified `out-*-verified/` snapshots).

```bat
emsdk_env.bat
python build.py --root C:\Users\joaov\usdwasm
```

Windows needs `.bat` shims for `emcmake`/`emmake` ahead of emsdk on PATH,
since `build_usd.py` invokes those literal names but current emsdk ships only
`.exe` launchers. All CMake cache paths in the bindings phase are normalized
to forward slashes, and the phase moves the Emscripten `LINK_FLAGS` value
into a Ninja response file because of its length.

The bindings link defaults to `-O2`. On this machine, the local emsdk 6.0.8
`wasm-opt` process has crashed while linking an otherwise fully compiled
tree; the observed failure mode is `local-build.log` recording a bindings
configure error and `logs/bindings.log` recording the crash during the final
link, not during compilation. The fallback re-links only the bindings phase
at `-O0`:

```bat
python build.py --root C:\Users\joaov\usdwasm --force bindings --bindings-link-o0
```

CI (`.github/workflows/build.yml`, manual dispatch only) keeps the default
`-O2` optimized link; it has not been observed to hit the same crash on its
`ubuntu-latest` runner (emcc `6.0.9` in the last recorded green run).

Logs land in `<root>/logs/{materialx,usd,bindings}.log`. Output lands in
`<root>/out/usdWebViewBindingsModule.{js,wasm}`; a recent local build produced
a 262,353-byte `.js` glue file and a `.wasm` in the 25.5-25.6 MB range
(compare against upstream's own shipped 19,733,084-byte `.wasm`; the
difference reflects the added patches, a different emcc, and MaterialX
support upstream does not build in).

The module is expected to link statically: no `dylink` section, no
`dynamicLibraries` entry, no GOT-relocation imports, and an import table
limited to the `env` and `wasi_snapshot_preview1` modules. The static-link
properties are checked by hand after a build, for example with
`wasm-objdump -x`; no script in this repository enforces them yet.

## Tests

Five fixtures live in `tests/`, one `.mjs` runner paired with one `.usda`
stage per patched behavior: `material-interface-inline`,
`material-texcoord-inline`, `material-time-samples-inline`,
`time-sampled-scene-transforms`, and `material-displacement-terminal-inline`.
Each loads the built module directly with Node's WebAssembly API (no browser,
no bundler), opens its paired `.usda` from an in-memory filesystem, and
asserts on the generated inline MaterialX XML or on the raw transform arrays
returned by `ExtractTransformsAtTime`. Run one against a build's output
directory with:

```sh
node tests/material-interface-inline.mjs C:\Users\joaov\usdwasm\out
```

The directory argument defaults to `<repo>/out` if omitted. These fixtures
are not wired into `.github/workflows/build.yml`, so running them is a manual
step after a build. The displacement-terminal fixture is the one explicitly
designed to fail against the pre-patch artifact: it asserts the emitted
`displacementshader` input names the connected `ConnectedDisplacement` node
and is not the scene's deliberately unrelated `OrphanDisplacement` prim,
which the old traversal-order lookup could have picked instead.

## Installing into the viewer

`scratchpad/install-approved-usd-bindings.ps1` in the MaterialXNodeDocs repo
installs a verified artifact directory (default
`C:\Users\joaov\usdwasm\out-production-verified`) over
`vendor/usd-webview-bindings/` in that repo. Before copying, it checks that
the source module passes `node --check` and a static ESM import probe, and
that the existing vendor wrapper still imports the versioned generated
module. It always takes a timestamped backup of the previously installed
`.js`/`.wasm` (with a `manifest.json` recording before/after sha256 hashes)
before overwriting, and re-verifies the copied files' hashes and static
import afterward. Without `-Install` it only reports what would change.

The caveat is that `scripts/vendor.mjs` in that repo independently pins the
three files' sha256 hashes against the unpatched upstream `usd-wg-webview`
commit `b050c373...`. A local install from this repository intentionally
diverges from those pinned hashes: as of this writing, the installed
`.js`/`.wasm` in that repo hash to `f0ddfc74...` / `fd31759e...`, neither of
which matches the pinned `c6965098...` / `0f2f5f97...`. Any `vendor` run,
`vendor --check` run, or fresh checkout that re-fetches by the pinned hashes
will silently revert to the unpatched artifact. A locally installed artifact
must be treated as temporary: resync (or update) the pins in
`scripts/vendor.mjs` before pushing that repo's `vendor/` state, and
reinstall from this repository's verified output after any operation that
re-runs `vendor`.

## Publishing

None of this has reached the deployed site yet. Getting there needs three
things: commit the patches and any build-script changes in this repository
(they currently apply cleanly to the pinned submodule commits but are not
part of a tagged release here); produce a release artifact from a CI run of
`.github/workflows/build.yml` (or an equivalently verified local build); and
repin `scripts/vendor.mjs` in MaterialXNodeDocs to a URL that serves the
patched artifact together with its new sha256 hashes, replacing the current
pins against the unpatched `usd-wg-webview` commit. Until that repin happens,
the pinned fetch path and any fresh `vendor` run will keep serving the
unpatched behavior described in the Local patches section, regardless of what
is installed locally.

## Verification record

A manual terminal audit was run over the 18 sample scenes in the MaterialEggs
library after the displacement-terminal patch. The counts are per egg
material, not per scene: the 18 scenes contain 25 egg materials, of which 14
have a MaterialX displacement terminal connected (all of type
ND_displacement_float) and 11 have none authored. The patched export picked up
all 14, invented none for the 11, and found zero orphan displacement nodes
(present in a scene but not wired to a material output). The audit was not
captured as an automated fixture; only the single connected-plus-orphan case
is covered by `tests/material-displacement-terminal-inline.mjs`.

Artifact hashes currently installed in the MaterialXNodeDocs
`vendor/usd-webview-bindings/`:

| file | sha256 |
|---|---|
| `usdWebViewBindingsModule.js` | `f0ddfc7405969474f0adf2af6c28c4f55ab8116fcde3571e4f46e31040743ef6` |
| `usdWebViewBindingsModule.wasm` | `fd31759e568c93751302482bb19d0d9d72eebc64f030717c980f1e5d098c19c0` |

These do not match the hashes pinned in that repo's `scripts/vendor.mjs`
(`c6965098...` for the `.js`, `0f2f5f97...` for the `.wasm`), which confirms
the installed artifact is the locally built, patched one from this
repository, not the pinned unpatched upstream fetch described in Installing
into the viewer and Publishing.

## Licence

This repository's own files, namely `build.py`, the tests, the patch
templates, and this documentation, are licensed under the Apache License
2.0. Each submodule keeps its upstream licence: OpenUSD under its
`LICENSE.txt` (Apache 2.0 with Pixar's modified trademark section),
MaterialX under Apache 2.0, and usd-wg-webview under BSD 3-Clause. Patched
upstream files remain under their upstream licence, and the templates in
`patches/` that modify usd-wg-webview files retain its BSD copyright notice.

Because the produced artifact bundles code from all three components, any
distribution of it must carry all three licence texts. The consumer repository
currently vendors only the usd-wg-webview `LICENSE` next to the artifact,
which needs the OpenUSD and MaterialX notices added when the patched artifact
is published.

A root `LICENSE` (Apache 2.0) and a `NOTICE` file listing the three
components do not yet exist in this repository and should be added before
publishing.
