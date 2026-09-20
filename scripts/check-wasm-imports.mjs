// Fails if the module looks dynamically linked: a dylink section, a
// non-empty "dynamicLibraries" entry in the JS glue, a GOT relocation
// import, or an import outside env/wasi_snapshot_preview1.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowed = new Set(['env', 'wasi_snapshot_preview1']);
const dynamicModules = new Set(['GOT.mem', 'GOT.func']);

export function findWasmImportProblems(buf) {
  const problems = [];
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
    // The section length itself is a LEB128 varint, so `off` must first
    // advance past it before adding the decoded length to find the end.
    const sectionLen = u32();
    const end = off + sectionLen;
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
        // Dynamic linking imports live in the GOT.mem/GOT.func modules, not
        // just any field name that happens to contain "GOT".
        if (dynamicModules.has(mod)) problems.push(`GOT relocation import "${mod}.${field}"`);
      }
    }
    off = end;
  }

  return problems;
}

export function findGlueProblems(glue) {
  const problems = [];
  // Only a non-empty dynamicLibraries array means the glue actually loads a
  // side module; the string can appear harmlessly in comments or dead code.
  const dynLibMatch = glue.match(/dynamicLibraries\s*:\s*(\[[^\]]*\])/);
  if (dynLibMatch) {
    try {
      const arr = JSON.parse(dynLibMatch[1].replace(/'/g, '"'));
      if (Array.isArray(arr) && arr.length > 0) problems.push('non-empty "dynamicLibraries" entry in the JS glue');
    } catch {
      problems.push('"dynamicLibraries" entry in the JS glue (could not parse its value)');
    }
  }
  return problems;
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: check-wasm-imports.mjs <out dir>'); process.exit(2); }
  const buf = fs.readFileSync(path.join(dir, 'usdWebViewBindingsModule.wasm'));
  const glue = fs.readFileSync(path.join(dir, 'usdWebViewBindingsModule.js'), 'utf8');
  const problems = [...findWasmImportProblems(buf), ...findGlueProblems(glue)];

  if (problems.length) {
    console.error('wasm import check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('wasm import check passed: static link, env/wasi_snapshot_preview1 only');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
