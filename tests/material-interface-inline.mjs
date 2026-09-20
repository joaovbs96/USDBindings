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

const stagePath = '/material-interface-inline.usda';
try {
  Module.InitializeRuntime();
  Module.FS_createDataFile(
    '/',
    stagePath.slice(1),
    fs.readFileSync(path.join(import.meta.dirname, 'material-interface-inline.usda')),
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
    const node = new RegExp(
      '<([A-Za-z_][\\w.]*)\\b[^>]*\\bname="' + name +
      '"[^>]*>([\\s\\S]*?)<\\/\\1>',
    ).exec(xml);
    assert.ok(node, `missing inline MaterialX node ${name}`);
    const inputs = new Map();
    const tags = node[2].matchAll(/<input\b([^>]*)\/>/g);
    for (const tag of tags) {
      const attrs = Object.fromEntries(
        [...tag[1].matchAll(/([A-Za-z_][\w:]*)="([^"]*)"/g)]
          .map((match) => [match[1], match[2]]),
      );
      inputs.set(attrs.name, attrs);
    }
    return inputs;
  };

  const assertNumericValue = (actual, expected, message) => {
    const values = String(actual).split(',').map(Number);
    assert.equal(values.length, expected.length, message);
    values.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]) < 1e-6, message);
    });
  };

  const mix = nodeInputs('Mix');
  assert.equal(mix.get('bg')?.type, 'color3');
  assertNumericValue(
    mix.get('bg')?.value,
    [0.097, 0.046634, 0.016199],
    'forwarded material-interface color must be preserved',
  );
  assert.equal(mix.get('fg')?.value, '0.5, 0.5, 0.5');
  assert.equal(mix.get('mix')?.value, '0');

  const probe = nodeInputs('InterfaceProbe');
  assert.equal(probe.get('floatValue')?.type, 'float');
  assert.equal(probe.get('floatValue')?.value, '0.25');
  assert.equal(probe.get('vectorValue')?.type, 'vector3');
  assertNumericValue(
    probe.get('vectorValue')?.value,
    [0.1, 0.2, 0.3],
    'forwarded material-interface vector must be preserved',
  );
  assert.equal(probe.has('cycleValue'), false, 'cyclic interface input must be omitted');
  assert.equal(probe.has('unresolvedValue'), false, 'unresolved input must be omitted');

  const illegal = nodeInputs('IllegalConsumer');
  assert.equal(
    illegal.has('value'),
    false,
    'a non-container Shader input is not a value-producing source',
  );

  const surface = nodeInputs('Surface');
  assert.equal(surface.get('base_color')?.nodename, 'Mix');
  assert.equal(surface.get('base_color')?.value, undefined);
  assert.equal(surface.get('normal')?.nodename, 'InterfaceProbe');
  assert.equal(surface.get('normal')?.output, 'resultVector');

  console.log(JSON.stringify({
    inlineBytes: data.byteLength,
    materialInterfaceValues: {
      color3: mix.get('bg')?.value,
      float: probe.get('floatValue')?.value,
      vector3: probe.get('vectorValue')?.value,
    },
    omitted: ['cycleValue', 'unresolvedValue', 'IllegalConsumer.value'],
    shaderOutput: surface.get('base_color')?.nodename,
  }, null, 2));
} finally {
  try { Module.CloseStage(stagePath); } catch {}
  try { Module.FS_unlink(stagePath); } catch {}
}
