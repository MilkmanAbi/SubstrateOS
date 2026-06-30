import { VFS } from '../src/vfs/VFS.js';
import { MemFS } from '../src/vfs/MemFS.js';
import { EventBus } from '../src/core/EventBus.js';
import { Fetcher } from '../src/net/Fetcher.js';
import { ObjectCache } from '../src/cache/ObjectCache.js';
import { RepoCache } from '../src/cache/RepoCache.js';
import { GitClient } from '../src/git/GitClient.js';
import { parseRepoSpec } from '../src/git/providers.js';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c)pass++; else {fail++; console.log('  FAIL:',m);} };

// spec parsing
ok(parseRepoSpec('github:MilkmanAbi/Sage-Playground').owner==='MilkmanAbi', 'parse github:');
ok(parseRepoSpec('MilkmanAbi/Sage-Playground@main').ref==='main', 'parse @ref');
ok(parseRepoSpec('https://github.com/MilkmanAbi/Sage-Playground/tree/main').ref==='main', 'parse url tree');
ok(parseRepoSpec('https://github.com/MilkmanAbi/Sage-Playground.git').repo==='Sage-Playground', 'parse .git');

const bus=new EventBus();
const vfs=new VFS(bus); vfs.mount('/', new MemFS());
const f=new Fetcher({bus});
const obj=new ObjectCache({bus}); const repos=new RepoCache({bus});
const git=new GitClient({fetcher:f, vfs, objectCache:obj, repoCache:repos, bus, provider:'jsdelivr'});

// clone only the top-level .js files + myst example (filter to keep it small/fast)
console.log('Cloning Sage-Playground (filtered)...');
const sum1 = await git.clone('github:MilkmanAbi/Sage-Playground', {
  ref:'main', into:'/repos/sage',
  filter: p => p.endsWith('.js') || p === 'README.md' || p.startsWith('Examples-Myst/sage-json/'),
});
console.log('  clone1:', JSON.stringify({files:sum1.files, fetched:sum1.fetched, reused:sum1.reused, kb:(sum1.bytesDownloaded/1024|0), ms:sum1.ms, provider:sum1.provider}));
ok(sum1.files>5, 'cloned several files');
ok(sum1.fetched>0, 'fetched from network');
ok(await vfs.exists('/repos/sage/sage-vfs.js'), 'sage-vfs.js present in VFS');
ok((await vfs.readText('/repos/sage/sage-vfs.js')).includes('SageVFS'), 'content correct');
ok(await vfs.exists('/repos/sage/.substrate/repo.json'), 'origin metadata written');

const st = await obj.stats();
ok(st.count>0, 'objects cached: '+st.count);

// Re-clone: should be ALL cache hits (incremental), near-zero network
console.log('Re-cloning (should be cache hits)...');
const sum2 = await git.clone('github:MilkmanAbi/Sage-Playground', {
  ref:'main', into:'/repos/sage2',
  filter: p => p.endsWith('.js') || p === 'README.md' || p.startsWith('Examples-Myst/sage-json/'),
});
console.log('  clone2:', JSON.stringify({files:sum2.files, fetched:sum2.fetched, reused:sum2.reused, kb:(sum2.bytesDownloaded/1024|0), ms:sum2.ms}));
ok(sum2.reused===sum2.files, 're-clone fully from cache (dedup): reused '+sum2.reused+'/'+sum2.files);
ok(sum2.bytesDownloaded===0, 're-clone downloaded 0 bytes');
ok(sum2.ms < sum1.ms, 're-clone faster ('+sum2.ms+'ms vs '+sum1.ms+'ms)');

// single file fetch
const onefile = await git.fetchFile('MilkmanAbi/Sage-Playground', 'README.md', {ref:'main'});
ok(onefile.byteLength>0, 'single file fetch');

// ls without download
const listing = await git.ls('MilkmanAbi/Sage-Playground', {ref:'main'});
ok(listing.length>10, 'ls returns full tree: '+listing.length+' files');

console.log(`\nGit: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
