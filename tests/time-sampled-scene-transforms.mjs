import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const bindingsDir = path.resolve(process.argv[2] || path.join(repo, 'out'));
const jsPath = path.join(bindingsDir, 'usdWebViewBindingsModule.js');
const wasmPath = path.join(bindingsDir, 'usdWebViewBindingsModule.wasm');
assert.ok(fs.existsSync(jsPath), `missing bindings JS: ${jsPath}`);
assert.ok(fs.existsSync(wasmPath), `missing bindings WASM: ${wasmPath}`);

const wasm = new Uint8Array(fs.readFileSync(wasmPath));
const factory = (await import(pathToFileURL(jsPath).href)).default;
const Module = await factory({
  instantiateWasm(imports, receiveInstance) {
    WebAssembly.instantiate(wasm, imports).then(({ instance }) => receiveInstance(instance));
    return {};
  },
});

const stagePath = '/time-sampled-scene-transforms.usda';
const readTransforms = (timeCode) => new Map(
  Array.from(Module.ExtractTransformsAtTime(stagePath, timeCode), (record) => [
    record.path,
    Array.from(record.matrix, Number),
  ]),
);
const assertMatrixNear = (actual, expected, message) => {
  assert.equal(actual?.length, 16, message);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-6, `${message} at ${index}`);
  });
};

try {
  Module.InitializeRuntime();
  Module.FS_createDataFile(
    '/',
    stagePath.slice(1),
    fs.readFileSync(path.join(import.meta.dirname, 'time-sampled-scene-transforms.usda')),
    true,
    true,
    true,
  );
  Module.OpenStage(stagePath, true);

  const atStart = readTransforms(1);
  assert.deepEqual(
    [...atStart.keys()].sort(),
    ['/World/Camera', '/World/Dome', '/World/Mesh'],
    'generic Xforms remain excluded while Mesh, Camera, and LightAPI records are emitted',
  );
  assertMatrixNear(
    atStart.get('/World/Mesh'),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
    'mesh start transform',
  );
  assertMatrixNear(
    atStart.get('/World/Camera'),
    [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 4, 5, 6, 1],
    'camera start transform',
  );
  assertMatrixNear(
    atStart.get('/World/Dome'),
    [-0.6427876, 0, 0.7660444, 0, 0, 1, 0, 0, -0.7660444, 0, -0.6427876, 0, 0, 0, 0, 1],
    'dome start transform',
  );

  const atEnd = readTransforms(2);
  assert.deepEqual(atEnd.get('/World/Mesh').slice(12, 15), [10, 20, 30]);
  assert.deepEqual(atEnd.get('/World/Camera').slice(12, 15), [40, 50, 60]);
  assertMatrixNear(
    atEnd.get('/World/Dome'),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    'dome end transform',
  );

  console.log(JSON.stringify({
    paths: [...atStart.keys()].sort(),
    startDomeMatrix: atStart.get('/World/Dome'),
    endTranslations: {
      mesh: atEnd.get('/World/Mesh').slice(12, 15),
      camera: atEnd.get('/World/Camera').slice(12, 15),
    },
  }, null, 2));
} finally {
  try { Module.CloseStage(stagePath); } catch {}
  try { Module.FS_unlink(stagePath); } catch {}
}
