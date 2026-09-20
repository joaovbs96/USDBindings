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

const stagePath = '/material-displacement-terminal-inline.usda';
try {
  Module.InitializeRuntime();
  Module.FS_createDataFile(
    '/',
    stagePath.slice(1),
    fs.readFileSync(path.join(import.meta.dirname, 'material-displacement-terminal-inline.usda')),
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

  const element = (category, name) => {
    const match = new RegExp(
      '<' + category + '\\b([^>]*)\\bname="' + name
        + '"([^>]*)>([\\s\\S]*?)<\\/' + category + '>',
    ).exec(xml);
    assert.ok(match, `missing ${category} ${name}`);
    const attrs = Object.fromEntries(
      [...`${match[1]} ${match[2]}`.matchAll(/([A-Za-z_][\w:]*)="([^"]*)"/g)]
        .map((attr) => [attr[1], attr[2]]),
    );
    const inputs = [...match[3].matchAll(/<input\b([^>]*)\/>/g)].map((input) => (
      Object.fromEntries(
        [...input[1].matchAll(/([A-Za-z_][\w:]*)="([^"]*)"/g)]
          .map((attr) => [attr[1], attr[2]]),
      )
    ));
    return { attrs, inputs };
  };

  const material = element('surfacematerial', 'M_DisplacedMaterial_inline');
  assert.deepEqual(material.inputs.find((input) => input.name === 'surfaceshader'), {
    name: 'surfaceshader',
    type: 'surfaceshader',
    nodename: 'Surface',
  });
  assert.deepEqual(material.inputs.find((input) => input.name === 'displacementshader'), {
    name: 'displacementshader',
    type: 'displacementshader',
    nodename: 'ConnectedDisplacement',
  });
  assert.notEqual(
    material.inputs.find((input) => input.name === 'displacementshader')?.nodename,
    'OrphanDisplacement',
    'terminal must follow the authored material output instead of shader traversal order',
  );

  const displacement = element('displacement', 'ConnectedDisplacement');
  assert.equal(displacement.attrs.type, 'displacementshader');
  assert.deepEqual(displacement.inputs.find((input) => input.name === 'displacement'), {
    name: 'displacement',
    type: 'float',
    nodename: 'Height',
  });
  assert.equal(displacement.inputs.find((input) => input.name === 'scale')?.value, '0.2');

  console.log(JSON.stringify({
    inlineBytes: data.byteLength,
    surfaceTerminal: material.inputs.find((input) => input.name === 'surfaceshader'),
    displacementTerminal: material.inputs.find((input) => input.name === 'displacementshader'),
    displacementType: displacement.attrs.type,
    displacementInput: displacement.inputs.find((input) => input.name === 'displacement'),
  }, null, 2));
} finally {
  try { Module.CloseStage(stagePath); } catch {}
  try { Module.FS_unlink(stagePath); } catch {}
}
