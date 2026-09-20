# USDBindings

This repository builds the WebAssembly USD bindings
(`usdWebViewBindings.js`, `usdWebViewBindingsModule.js`,
`usdWebViewBindingsModule.wasm`) used by the MaterialX Playground USD Scene
viewer (https://github.com/joaovbs96/MaterialXPlayground), from OpenUSD and
the USD Working Group's `usd-wg-webview`, plus a set of local patches.

## Upstream sources

| submodule | commit |
|---|---|
| OpenUSD | `ee47c679abde5b467a7b6a41f3b2285564a4222e` (`v26.08`; built with Imaging and MaterialX on, GL off, OpenSubdiv static) |
| MaterialX | `7b64921ef1d42f2d57871e9d2c43dc11f041f26b` |
| usd-wg-webview | `b050c3731d1854a5980b6b4fe55ec1725dc18f51` |

## Patches

All patches live in `patches/` as `.cpp.in`/`.cmake.in` templates. `build.py`
applies each one to the submodule working trees at build time, so the
submodules must not be committed with patches inside them.

| template | upstream file | fixes |
|---|---|---|
| `emit-material-interface-values.cpp.in` | `materials.cpp` (`_AppendMtlxInputXml`) | a shader input connected to a Material/NodeGraph interface input lost that connection instead of resolving through it |
| `preserve-material-texcoord.cpp.in` | `materials.cpp` (`_AppendMtlxInputXml`) | any input literally named `texcoord` was dropped even when authored or connected |
| `evaluate-material-values-at-stage-start.cpp.in` | `materials.cpp` (`_AppendMtlxInputXml`) | values were read at USD default time, missing time-sampled attributes; reads now use the stage's start time code |
| `emit-scene-transforms.cpp.in` | `stageApi.cpp` (`ExtractTransformsAtTime`) | only mesh transforms were emitted; camera and light transforms are now included |
| `emit-material-displacement-terminal.cpp.in` | `materials.cpp` | only a hard-coded `surfaceshader` terminal was emitted and the shader lookup picked by traversal order rather than the authored connection; displacement is now typed and resolved correctly |
| `configure-bindings-link.cmake.in` | `CMakeLists.txt` | pins OpenSubdiv to its static archive and exposes the bindings link optimization level as a cache variable |
| WASM platform guard | `pxr/imaging/hgi/hgi.cpp` | adds a WASM branch to the platform Hgi dispatch, without which the file does not compile under Emscripten |
| geomprop streaming (`expand-float-primvar.cpp.in` + `emit-geomprops.cpp.in`) | `unifiedDriver.cpp` | lets `geompropvalue` MaterialX nodes read any scalar or vector primvar, not only `st` and `normals` |

## Build

Prerequisites: emsdk 6.0.8, CMake 3.31.4, Python 3.11, and on Windows Visual
Studio with Ninja on PATH. An OpenUSD SDK root is passed with `--root`.

```
python build.py --root <sdk root>
```

If `wasm-opt` fails during the optimized bindings link, re-link just the
bindings phase at `-O0`:

```
python build.py --root <sdk root> --force bindings --bindings-link-o0
```

Compilation stays Release either way; only the bindings link optimization
level changes. CI links optimized.

Output lands in `<root>/out/usdWebViewBindingsModule.{js,wasm}`. Logs land in
`<root>/logs/{materialx,usd,bindings}.log`.

A build must pass these static checks on the produced module: no dynamic
linking imports (no `dylink` section, no `dynamicLibraries` entry, no
GOT-relocation imports), and an import table limited to the `env` and
`wasi_snapshot_preview1` modules.

Releases are built by CI (`.github/workflows/build.yml`) from a pushed tag
`v<major>.<minor>.<patch>`, after the fixtures below and the static checks
above both pass. The GitHub Release for that tag carries
`usdWebViewBindings.js`, `usdWebViewBindingsModule.js`,
`usdWebViewBindingsModule.wasm`, a `SHA256SUMS` file with their hashes, and a
`LICENSES.txt` bundling this repository's licence and notice with OpenUSD's,
MaterialX's, and usd-wg-webview's. MaterialX Playground's `scripts/vendor.mjs`
pins a specific release by its asset URL and the matching `SHA256SUMS` hash,
the same way it pins every other third-party download.

## Tests

Five fixtures live in `tests/`, one `.mjs` runner paired with one `.usda`
stage each. Run one against a build's output directory:

```
node tests/material-interface-inline.mjs <out dir>
```

- `material-interface-inline` covers shader inputs connected to a
  Material/NodeGraph interface input.
- `material-texcoord-inline` covers connected, literal, and implicit
  `texcoord` inputs.
- `material-time-samples-inline` covers values resolved at the stage's
  start time code instead of USD default time.
- `time-sampled-scene-transforms` covers time-sampled Mesh, Camera, and
  DomeLight transforms.
- `material-displacement-terminal-inline` covers the displacement terminal
  following the authored connection instead of traversal order.

## Using the artifact in MaterialX Playground

MaterialX Playground's `scripts/vendor.mjs` pins the upstream
`usd-wg-webview` artifact by URL and sha256. A locally built artifact is
installed over `vendor/usd-webview-bindings/` with that repository's install
script, and `npm run vendor` restores the pinned fetch.

## Licence

This repository's own files are licensed under the Apache License 2.0 (see
`LICENSE` and `NOTICE`). OpenUSD keeps its `LICENSE.txt` (Apache 2.0 with
Pixar's modified trademark section), MaterialX is Apache 2.0, and
usd-wg-webview is BSD 3-Clause. Patched upstream files and the templates
that modify them stay under the upstream licence. A distribution of the
built artifact carries all three licence texts.
