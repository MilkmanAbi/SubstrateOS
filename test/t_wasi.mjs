import { readFileSync } from 'node:fs';
import { Wasi, WasiFS } from '../src/wasm/Wasi.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

function instantiate(bytes, wasi) {
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.imports() });
  wasi.bind(inst);
  return inst;
}
function start(inst, wasi) {
  try { inst.exports._start(); }
  catch (e) { if (e.name !== 'WasmExit') throw e; }
  return wasi.exitCode;
}

// --- test 1: hello -> stdout ---
{
  let out = new Uint8Array(0);
  const sink = (b) => { const n = new Uint8Array(out.length + b.length); n.set(out); n.set(b, out.length); out = n; };
  const wasi = new Wasi({ stdout: sink });
  const inst = instantiate(readFileSync(new URL('./fixtures/hello.wasm', import.meta.url)), wasi);
  const code = start(inst, wasi);
  const text = new TextDecoder().decode(out);
  ok(code === 0, 'hello exit 0 (got ' + code + ')');
  ok(text === 'hello from wasi\n', 'hello stdout matches (got ' + JSON.stringify(text) + ')');
}

// --- test 2: cat reads preopened file, echoes to stdout ---
{
  const content = 'the interpreter read this source file\nline 2\n';
  const fs = new WasiFS();
  fs.mkdir('/sandbox');
  fs.write('/sandbox/input.txt', new TextEncoder().encode(content));
  let out = new Uint8Array(0);
  const sink = (b) => { const n = new Uint8Array(out.length + b.length); n.set(out); n.set(b, out.length); out = n; };
  const wasi = new Wasi({ preopens: { '.': '/sandbox' }, fs, stdout: sink });
  const inst = instantiate(readFileSync(new URL('./fixtures/cat.wasm', import.meta.url)), wasi);
  const code = start(inst, wasi);
  const text = new TextDecoder().decode(out);
  ok(code === 0, 'cat exit 0 (got ' + code + ')');
  ok(text === content, 'cat echoed file via path_open+fd_read (got ' + JSON.stringify(text.slice(0,30)) + '...)');
}

// --- test 3: writeback - program writes a file, we read it from WasiFS ---
// (reuse cat path_open with CREAT semantics through the shim directly)
{
  const fs = new WasiFS();
  fs.mkdir('/work');
  const wasi = new Wasi({ preopens: { '.': '/work' }, fs });
  // emulate: a module-less direct shim exercise of path_open CREAT + fd_write
  // build a tiny module inline that creates out.txt and writes to it
}

console.log(`\nWASI: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
