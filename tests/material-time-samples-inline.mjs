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

const stagePath = '/material-time-samples-inline.usda';
try {
  Module.InitializeRuntime();
  Module.FS_createDataFile(
    '/',
    stagePath.slice(1),
    fs.readFileSync(path.join(import.meta.dirname, 'material-time-samples-inline.usda')),
    true,
    true,
    true,
  );
  Module.OpenStage(stagePath, true);
  const payloads = Module.ExtractMaterialPayloads(stagePath);
  assert.equal(payloads.length, 1, 'fixture should expose one bound material');
  const data = payloads[0]?.material?.materialX?.data;
  assert.ok(data?.byteLength, 'fixture should produce inline MaterialX');
  const xml = new TextDecoder().decode(data);

  const nodeInputs = (name) => {
    const match = new RegExp(
      '<([A-Za-z_][\\w.]*)\\b[^>]*\\bname="' + name +
      '"[^>]*>([\\s\\S]*?)<\\/\\1>',
    ).exec(xml);
    assert.ok(match, `missing inline MaterialX node ${name}`);
    return new Map([...match[2].matchAll(/<input\b([^>]*)\/>/g)].map((input) => {
      const attrs = Object.fromEntries(
        [...input[1].matchAll(/([A-Za-z_][\w:]*)="([^"]*)"/g)]
          .map((attr) => [attr[1], attr[2]]),
      );
      return [attrs.name, attrs];
    }));
  };
  const numeric = (value) => String(value).split(',').map(Number);
  const close = (actual, expected, label) => {
    assert.equal(actual.length, expected.length, label);
    actual.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]) < 1e-6, `${label}: ${value}`);
    });
  };

  const mix = nodeInputs('Mix');
  close(numeric(mix.get('bg')?.value), [0.11, 0.22, 0.33], 'interface sample at stage start');
  assert.equal(mix.get('fg')?.value, '0.5, 0.5, 0.5', 'direct default color remains intact');
  assert.equal(mix.get('mix')?.value, '0', 'direct default float remains intact');

  const surface = nodeInputs('Surface');
  assert.equal(surface.get('base_color')?.nodename, 'Mix', 'shader output connection remains intact');
  assert.equal(surface.get('base_color')?.value, undefined);

  const noise = nodeInputs('NoiseOffset');
  close(numeric(noise.get('offset')?.value), [4.4, 1.0050167, 20], 'direct vector sample at stage start');
  assert.equal(noise.get('sampleOnly')?.value, '0.125', 'sample-only float resolves at stage start');
  assert.equal(noise.get('defaultOnly')?.value, '0.375', 'default-only float remains available');

  console.log(JSON.stringify({
    stageStart: 1,
    interfaceColor: mix.get('bg')?.value,
    animatedOffset: noise.get('offset')?.value,
    sampleOnly: noise.get('sampleOnly')?.value,
    defaultOnly: noise.get('defaultOnly')?.value,
  }, null, 2));
} finally {
  try { Module.CloseStage(stagePath); } catch {}
  try { Module.FS_unlink(stagePath); } catch {}
}