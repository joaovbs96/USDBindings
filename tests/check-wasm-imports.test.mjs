import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWasmImportProblems, findGlueProblems } from '../scripts/check-wasm-imports.mjs';

function uleb128(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return Buffer.from(bytes);
}

function wasmName(str) {
  const s = Buffer.from(str, 'utf8');
  return Buffer.concat([uleb128(s.length), s]);
}

function section(id, payload) {
  return Buffer.concat([Buffer.from([id]), uleb128(payload.length), payload]);
}

function typeSection() {
  // One empty () -> () function type.
  const payload = Buffer.concat([uleb128(1), Buffer.from([0x60]), uleb128(0), uleb128(0)]);
  return section(1, payload);
}

function funcImportEntry(mod, field) {
  return Buffer.concat([wasmName(mod), wasmName(field), Buffer.from([0x00]), uleb128(0)]);
}

function importSection(entries) {
  const payload = Buffer.concat([uleb128(entries.length), ...entries]);
  return section(2, payload);
}

function customSection(name, extraPayload = Buffer.alloc(0)) {
  const nameBuf = wasmName(name);
  return section(0, Buffer.concat([nameBuf, extraPayload]));
}

function wasmModule(sections) {
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, ...sections]);
}

test('a statically linked module with only env/wasi imports passes', () => {
  const buf = wasmModule([
    typeSection(),
    importSection([funcImportEntry('env', 'memory_base'), funcImportEntry('wasi_snapshot_preview1', 'fd_write')]),
  ]);
  assert.deepEqual(findWasmImportProblems(buf), []);
});

test('a dylink custom section is rejected', () => {
  const buf = wasmModule([customSection('dylink', Buffer.from([0x00, 0x00, 0x00, 0x00])), typeSection()]);
  const problems = findWasmImportProblems(buf);
  assert.ok(problems.some((p) => p.includes('dylink section')));
});

test('a dylink.0 custom section is rejected', () => {
  const buf = wasmModule([customSection('dylink.0', Buffer.from([0x00])), typeSection()]);
  const problems = findWasmImportProblems(buf);
  assert.ok(problems.some((p) => p.includes('dylink.0')));
});

test('a GOT.mem import module is rejected', () => {
  const buf = wasmModule([typeSection(), importSection([funcImportEntry('GOT.mem', 'someGlobal')])]);
  const problems = findWasmImportProblems(buf);
  assert.ok(problems.some((p) => p.includes('GOT relocation import')));
  assert.ok(problems.some((p) => p.includes('disallowed module')));
});

test('a GOT.func import module is rejected', () => {
  const buf = wasmModule([typeSection(), importSection([funcImportEntry('GOT.func', 'someFunc')])]);
  const problems = findWasmImportProblems(buf);
  assert.ok(problems.some((p) => p.includes('GOT relocation import')));
});

test('an env field name that merely contains GOT is not a false positive', () => {
  const buf = wasmModule([typeSection(), importSection([funcImportEntry('env', 'GOT.mem.internal_stub')])]);
  assert.deepEqual(findWasmImportProblems(buf), []);
});

test('an import from a disallowed module is rejected', () => {
  const buf = wasmModule([typeSection(), importSection([funcImportEntry('wasi_unstable', 'fd_write')])]);
  const problems = findWasmImportProblems(buf);
  assert.ok(problems.some((p) => p.includes('disallowed module "wasi_unstable"')));
});

test('multi-byte LEB128 section lengths do not desync parsing', () => {
  // Pad a custom section past 127 bytes so its own length needs a 2-byte
  // varint; a real import section must still be found correctly afterward.
  const padding = Buffer.alloc(200, 0x41);
  const buf = wasmModule([
    customSection('padding_section_name', padding),
    typeSection(),
    importSection([funcImportEntry('env', 'memory_base')]),
  ]);
  assert.deepEqual(findWasmImportProblems(buf), []);
});

test('glue with an empty dynamicLibraries array is not flagged', () => {
  const glue = 'var Module = { dynamicLibraries: [] };';
  assert.deepEqual(findGlueProblems(glue), []);
});

test('glue merely mentioning dynamicLibraries in a comment is not flagged', () => {
  const glue = '// this build does not use dynamicLibraries at all\nvar x = 1;';
  assert.deepEqual(findGlueProblems(glue), []);
});

test('glue with a non-empty dynamicLibraries array is flagged', () => {
  const glue = "var Module = { dynamicLibraries: ['side.wasm'] };";
  const problems = findGlueProblems(glue);
  assert.ok(problems.some((p) => p.includes('dynamicLibraries')));
});
