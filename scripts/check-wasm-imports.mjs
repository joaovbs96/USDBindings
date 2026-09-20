// Fails if the module looks dynamically linked: a dylink section, a
// "dynamicLibraries" entry in the JS glue, a GOT relocation import, or an
// import outside env/wasi_snapshot_preview1.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: check-wasm-imports.mjs <out dir>'); process.exit(2); }
const buf = fs.readFileSync(path.join(dir, 'usdWebViewBindingsModule.wasm'));
const problems = [];
const allowed = new Set(['env', 'wasi_snapshot_preview1']);

let off = 8; // skip \0asm + version
function u32() {
  let result = 0, shift = 0, byte;
  do { byte = buf[off++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return result >>> 0;
}
function name() {
  const len = u32();
  const s = buf.toString('utf8', off, off + len);
  off += len;
  return s;
}

while (off < buf.length) {
  const id = buf[off++];
  const end = off + u32();
  if (id === 0) {
    const sectionName = name();
    if (sectionName === 'dylink' || sectionName === 'dylink.0') problems.push(`dylink section ("${sectionName}")`);
  } else if (id === 2) {
    const count = u32();
    for (let i = 0; i < count; i++) {
      const mod = name(), field = name(), kind = buf[off++];
      if (kind === 0x00) u32();
      else if (kind === 0x01) { off += 1; const flags = buf[off++]; u32(); if (flags & 1) u32(); }
      else if (kind === 0x02) { const flags = buf[off++]; u32(); if (flags & 1) u32(); }
      else if (kind === 0x03) off += 2;
      if (!allowed.has(mod)) problems.push(`import from disallowed module "${mod}" (${field})`);
      if (field.startsWith('GOT.')) problems.push(`GOT relocation import "${mod}.${field}"`);
    }
  }
  off = end;
}

const glue = fs.readFileSync(path.join(dir, 'usdWebViewBindingsModule.js'), 'utf8');
if (glue.includes('dynamicLibraries')) problems.push('"dynamicLibraries" entry in the JS glue');

if (problems.length) {
  console.error('wasm import check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('wasm import check passed: static link, env/wasi_snapshot_preview1 only');
