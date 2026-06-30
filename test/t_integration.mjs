/**
 * Integration test: the whole kernel through the public createSubstrate() API.
 * Uses the real network (jsDelivr) for the clone, and the real WASM binaries
 * built in test/fixtures for the run.
 */
import { readFileSync } from 'node:fs';
import { createSubstrate } from '../src/substrate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

const sb = await createSubstrate({ persist: false });

// kernel events visible through the facade
const phases = new Set();
sb.on('git:progress', (d) => phases.add(d.phase));

// 1) clone a real repo via the CDN transport
{
  const summary = await sb.git.clone('github:MilkmanAbi/Sage-Playground', {
    into: '/opt/sage',
    ref: 'main',
    filter: (p) => p.endsWith('.js') || p.endsWith('.json') || p.endsWith('.md'),
  });
  ok(summary.files > 0, `cloned ${summary.files} files via ${summary.provider} in ${summary.ms}ms`);
  ok(phases.has('resolve') && phases.has('done'), 'git:progress phases surfaced through facade');
  ok(await sb.fs.exists('/opt/sage'), 'clone landed in the VFS');
}

// 2) second clone to a different dir reuses the object cache (near-zero network)
{
  const s2 = await sb.git.clone('github:MilkmanAbi/Sage-Playground', {
    into: '/opt/sage2', ref: 'main',
    filter: (p) => p.endsWith('.js') || p.endsWith('.json') || p.endsWith('.md'),
  });
  ok(s2.reused > 0 && s2.fetched === 0, `re-clone reused ${s2.reused}, fetched ${s2.fetched}, ${s2.bytesDownloaded}B`);
  ok(s2.ms < 500, `cached clone fast (${s2.ms}ms)`);
}

// 3) drop wasm into the VFS and run it through sb.wasm against a VFS preopen
{
  await sb.fs.mkdir('/bin');
  await sb.fs.writeFile('/bin/cat.wasm', readFileSync(new URL('./fixtures/cat.wasm', import.meta.url)));
  await sb.fs.mkdir('/work');
  await sb.fs.writeText('/work/input.txt', 'substrate runs wasm over its own VFS\n');

  let live = '';
  const r = await sb.wasm.run('/bin/cat.wasm', {
    preopens: { '.': '/work' },
    stdout: (b) => { live += new TextDecoder().decode(b); },
  });
  ok(r.exitCode === 0, 'wasm run exit 0');
  ok(r.stdoutText === 'substrate runs wasm over its own VFS\n', 'wasm read VFS file: ' + JSON.stringify(r.stdoutText));
}

// 4) load + run an ES module out of the VFS through sb.modules
{
  await sb.fs.mkdir('/js/lib');
  await sb.fs.writeText('/js/lib/math.js', `export const add = (a,b) => a+b;`);
  await sb.fs.writeText('/js/index.js', `
    import { add } from './lib/math.js';
    export function compute(xs) { return xs.reduce(add, 0); }
  `);
  const mod = await sb.modules.import('/js/index.js');
  ok(mod.compute([1,2,3,4]) === 10, 'imported VFS module computed correctly');
}

// 5) copy-on-write workspace: overlay over the cloned tree, edit, lower stays clean
{
  const ws = await sb.cloneWorkspace('github:MilkmanAbi/Sage-Playground', {
    into: '/opt/sage3', workdir: '/work/sage', ref: 'main',
    filter: (p) => p === 'README.md',
  });
  ok(await sb.fs.exists('/work/sage/README.md'), 'overlay exposes cloned README');
  await sb.fs.writeText('/work/sage/README.md', 'LOCAL EDIT');
  const upper = await sb.fs.readText('/work/sage/README.md');
  const lower = await sb.fs.readText('/opt/sage3/README.md');
  ok(upper === 'LOCAL EDIT', 'edit visible on overlay');
  ok(lower !== 'LOCAL EDIT' && lower.length > 0, 'lower (cloned) copy untouched by overlay edit');
  ok(ws.overlay.isDirty(), 'overlay reports dirty');
  ws.overlay.reset();
  const afterReset = await sb.fs.readText('/work/sage/README.md');
  ok(afterReset === lower, 'reset() discarded the edit, restored from lower');
}

sb.dispose();
console.log(`\nINTEGRATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
