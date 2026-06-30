import { VFS } from '../src/vfs/VFS.js';
import { MemFS } from '../src/vfs/MemFS.js';
import { EventBus } from '../src/core/EventBus.js';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;} else {fail++; console.log('  FAIL:',m);} };

const bus=new EventBus();
const vfs=new VFS(bus);
vfs.mount('/', new MemFS(), 'memfs');

await vfs.mkdir('/repos/sage');
await vfs.writeText('/repos/sage/main.sage', 'proc main(): println("hi")\n');
await vfs.writeText('/repos/sage/lib/util.sage', 'export x = 1\n');
ok(await vfs.exists('/repos/sage/main.sage'), 'file exists');
ok((await vfs.readText('/repos/sage/main.sage')).includes('hi'), 'readText');
const ls = await vfs.list('/repos/sage');
ok(ls.length===2, 'list count '+ls.length);
ok(ls[0].type==='dir', 'dir sorts first');

// walk
let count=0; for await (const e of vfs.walk('/repos')) count++;
ok(count===4, 'walk count '+count); // sage, main.sage, lib, util.sage

// overlay copy-on-write
const ov = vfs.overlay('/repos/sage', '/work');
await ov.ready;
ok((await vfs.readText('/work/main.sage')).includes('hi'), 'overlay reads lower');
await vfs.writeText('/work/main.sage', 'EDITED\n');
ok((await vfs.readText('/work/main.sage'))==='EDITED\n', 'overlay write to upper');
ok((await vfs.readText('/repos/sage/main.sage')).includes('hi'), 'lower UNCHANGED after overlay edit');
ok(await ov.isDirty(), 'overlay dirty');
await vfs.writeText('/work/new.sage', 'brand new\n');
const wls = await vfs.list('/work');
ok(wls.find(e=>e.name==='new.sage'), 'overlay new file in listing');
ok(wls.find(e=>e.name==='lib'), 'overlay shows lower dir');

// whiteout
await vfs.remove('/work/main.sage');
ok(!(await vfs.exists('/work/main.sage')), 'whiteout hides file');
ok((await vfs.readText('/repos/sage/main.sage')).includes('hi'), 'lower still has whited-out file');

// reset
await ov.reset();
ok((await vfs.readText('/work/main.sage')).includes('hi'), 'reset restores from lower');
ok(!(await vfs.exists('/work/new.sage')), 'reset drops new file');
ok(!(await ov.isDirty()), 'overlay clean after reset');

console.log(`\nVFS/Overlay: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
