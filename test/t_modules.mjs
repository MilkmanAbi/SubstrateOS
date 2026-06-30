import { VFS } from '../src/vfs/VFS.js';
import { MemFS } from '../src/vfs/MemFS.js';
import { EventBus } from '../src/core/EventBus.js';
import { ModuleLoader } from '../src/module/ModuleLoader.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

const vfs = new VFS();
await vfs.mount('/', new MemFS());

// a tiny multi-file "interpreter" living in the VFS
await vfs.mkdir('/lang/meta');
await vfs.writeText('/lang/util.js', `export const isSpace = (c) => c === ' ';`);
await vfs.writeText('/lang/meta/info.js', `export const VERSION = '1.2.3';`);
await vfs.writeText('/lang/lexer.js', `
import { isSpace } from './util.js';
// a comment with a misleading import from './fake.js'
const decoy = "import x from './also-fake.js'";
export function tokenize(s) {
  const toks = []; let cur = '';
  for (const c of s) { if (isSpace(c)) { if (cur) { toks.push(cur); cur=''; } } else cur += c; }
  if (cur) toks.push(cur);
  return toks;
}
`);
await vfs.writeText('/lang/index.js', `
import { tokenize } from './lexer.js';
import { VERSION } from './meta/info.js';
import { isSpace } from './util';          // extensionless
export function run(src) { return { tokens: tokenize(src), version: VERSION, space: isSpace(' ') }; }
`);

const bus = new EventBus();
const linkEvents = [];
bus.on('*', (d, t) => { if (String(t).startsWith('module:')) linkEvents.push(t); });
const loader = new ModuleLoader({ vfs, bus });

// 1) import the entry, run it
{
  const mod = await loader.import('/lang/index.js');
  ok(typeof mod.run === 'function', 'index.js exported run()');
  const r = mod.run('hello   world  foo');
  ok(JSON.stringify(r.tokens) === JSON.stringify(['hello','world','foo']), 'tokenizer linked across files: ' + JSON.stringify(r.tokens));
  ok(r.version === '1.2.3', 'nested ./meta/info.js linked: ' + r.version);
  ok(r.space === true, 'extensionless ./util resolved');
}

// 2) decoy import inside string/comment was NOT treated as a real dep
{
  const linkCount = linkEvents.filter(t => t === 'module:link').length;
  ok(linkCount === 4, `linked exactly 4 modules (index,lexer,util,info), got ${linkCount}`);
}

// 3) content cache: re-import unchanged graph relinks nothing new
{
  linkEvents.length = 0;
  const mod = await loader.import('/lang/index.js');
  ok(typeof mod.run === 'function', 're-import still works');
  const relinked = linkEvents.filter(t => t === 'module:link').length;
  ok(relinked === 0, `unchanged re-import relinked 0 modules, got ${relinked}`);
}

// 4) invalidate after edit -> picks up new content
{
  await vfs.writeText('/lang/meta/info.js', `export const VERSION = '9.9.9';`);
  loader.invalidate('/lang/meta/info.js');
  loader.invalidate('/lang/index.js');     // its dep url changed
  const mod = await loader.import('/lang/index.js', { force: true });
  const r = mod.run('x');
  ok(r.version === '9.9.9', 'edited module reflected after invalidate: ' + r.version);
}

// 5) cycle detection
{
  await vfs.writeText('/cyc/a.js', `import './b.js'; export const A = 1;`);
  await vfs.writeText('/cyc/b.js', `import './a.js'; export const B = 2;`);
  let threw = null;
  try { await loader.import('/cyc/a.js'); } catch (e) { threw = e; }
  ok(threw && /cycle/i.test(threw.message), 'import cycle detected and reported: ' + (threw && threw.message));
}

// 6) evaluate a standalone source string with an externals mapping
{
  const greetUrl = 'data:text/javascript,export const hi = (n) => "hi " + n;';
  const mod = await loader.evaluate(`import { hi } from 'greet'; export const msg = hi('abi');`, { externals: { greet: greetUrl } });
  ok(mod.msg === 'hi abi', 'evaluate() with externals mapping: ' + mod.msg);
}

console.log(`\nMODULES: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
