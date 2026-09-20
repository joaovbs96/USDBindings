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

const stagePath = '/material-texcoord-inline.usda';
try {
  Module.InitializeRuntime();
  Module.FS_createDataFile(
    '/',
    stagePath.slice(1),
    fs.readFileSync(path.join(import.meta.dirname, 'material-texcoord-inline.usda')),
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

  const inputs = (name) => {
    const node = new RegExp(
      '<([A-Za-z_][\\w.]*)\\b[^>]*\\bname="' + name
        + '"[^>]*>([\\s\\S]*?)<\\/\\1>',
    ).exec(xml);
    assert.ok(node, `missing inline MaterialX node ${name}`);
    return [...node[2].matchAll(/<input\b([^>]*)\/>/g)].map((tag) => (
      Object.fromEntries(
        [...tag[1].matchAll(/([A-Za-z_][\w:]*)="([^"]*)"/g)]
          .map((match) => [match[1], match[2]]),
      )
    ));
  };
  const texcoord = (name) => inputs(name).filter((input) => input.name === 'texcoord');

  const connected = texcoord('ConnectedConsumer');
  assert.equal(connected.length, 1, 'connected texcoord should be emitted once');
  assert.equal(connected[0].type, 'vector2');
  assert.equal(connected[0].nodename, 'TexcoordSource');
  assert.equal(connected[0].value, undefined);

  const literal = texcoord('LiteralConsumer');
  assert.equal(literal.length, 1, 'literal texcoord should be emitted once');
  assert.equal(literal[0].type, 'vector2');
  const numbers = literal[0].value.split(',').map(Number);
  assert.equal(numbers.length, 2);
  assert.ok(Math.abs(numbers[0] - 0.25) < 1e-6);
  assert.ok(Math.abs(numbers[1] - 0.75) < 1e-6);

  assert.equal(
    texcoord('ImplicitConsumer').length,
    0,
    'an unauthored texcoord must remain omitted for the MaterialX default',
  );

  console.log(JSON.stringify({
    inlineBytes: data.byteLength,
    connectedTexcoord: connected[0],
    literalTexcoord: literal[0],
    implicitTexcoordCount: 0,
  }, null, 2));
} finally {
  try { Module.CloseStage(stagePath); } catch {}
  try { Module.FS_unlink(stagePath); } catch {}
}
