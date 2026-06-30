# Substrate

A browser-native backend kernel for static web apps. No server, no GUI.

Substrate is the engine you put underneath a web IDE, playground, or any static
site that needs to fetch real code and run it. It gives you a virtual
filesystem, `git clone` over a CDN with aggressive content-addressed caching, a
WASM runtime that executes cloned `wasm32-wasi` binaries against that
filesystem, and an in-memory ES module loader that imports cloned JavaScript
with its relative imports linked. All of it runs in the page (or a worker) on
plain static hosting like GitHub Pages.

This is a rewrite. The old SubstrateOS shipped a terminal and an app shell
(BORK/BARK). That is gone. The UI is the application developer's job. Substrate
is only the kernel.

## The thing it is built for

Clone a language toolchain from GitHub, run its native bits as WASM over your
files, and load its JS driver straight from the cloned tree, then do it again
next page-load for almost no network cost:

```js
import { createSubstrate } from 'substrate';

const sb = await createSubstrate({ persist: true });

// 1. clone a repo. second time across any dir, it comes from cache.
await sb.git.clone('github:owner/lang', { into: '/opt/lang' });

// 2. run a cloned wasm binary against the VFS
await sb.fs.writeText('/work/main.lang', 'print "hi"');
const out = await sb.wasm.run('/opt/lang/bin/lang.wasm', {
  args: ['lang', '/src/main.lang'],
  preopens: { '/src': '/work' },        // guest dir -> VFS path
  stdout: chunk => term.write(chunk),
});
console.log(out.exitCode, out.stdoutText);

// 3. import the cloned JS driver, linked in memory
const driver = await sb.modules.import('/opt/lang/js/index.js');
driver.run('...');
```

## Architecture

```
                         createSubstrate()
                                |
   EventBus  <-------- all subsystems emit progress here
      |
   +--+----------+-----------+-----------+--------------+
   |  VFS        | GitClient | WasmRuntime| ModuleLoader |
   | (mount      | (clone /  | (WASI over | (link ESM    |
   |  router)    |  pull /   |  the VFS)  |  from VFS)   |
   |             |  fetch)   |            |              |
   |             |    |      |            |              |
 MemFS / IDBFS   | providers | Wasi shim  | blob/data    |
 OverlayFS /     | (jsDelivr | + WasiFS   | URL linker   |
 SubtreeView     |  / GitHub)|            |              |
                 |    |      |            |
              Fetcher | ObjectCache (content-addressed)
              (retry, | RepoCache  (manifests)
               proxy) | Store (IndexedDB KV, mem fallback)
```

### Virtual filesystem

A path-keyed mount router. You mount backends at paths and the longest-prefix
match wins, the same way a real kernel routes to mounted filesystems.

- `MemFS` - in-RAM, the default root.
- `IDBFS` - persists to IndexedDB, survives reloads (`persist: true`).
- `OverlayFS` - copy-on-write. A read-only lower (your cloned tree) plus a
  writable upper (the user's edits). Deletions are whiteouts. `reset()` throws
  the edits away and restores the pristine tree. This is the feature that makes
  a safe, resettable IDE workspace cheap.
- `SubtreeView` - a chrooted view of another mount, used as an overlay lower.

Every backend implements the same contract (`stat`, `list`, `readFile`,
`writeFile`, `mkdir`, `remove`, `rename`, `exists`, `exportTree`, `importTree`),
so you can write your own (a zip backend, a remote backend) and mount it.

### git clone over a CDN

The transport is jsDelivr, not the GitHub API. One request to
`data.jsdelivr.com/v1/packages/gh/{owner}/{repo}@{ref}?structure=flat` returns
the entire flat file tree with a per-file SHA-256, with no rate limit and
CORS-friendly. File bytes come from `cdn.jsdelivr.net`. The GitHub trees API is
a fallback for cases jsDelivr does not serve, and it is rate-limited.

Because the manifest already carries each file's content hash, that hash is the
cache key. The first clone fills an `ObjectCache` keyed by content hash; any
later clone of the same (or an overlapping) tree, into any directory, reuses
those objects and fetches zero bytes for unchanged files. A `RepoCache` stores
the resolved manifest so `pull()` and incremental re-clones only fetch what
actually changed.

Repo specs accept `github:owner/repo`, `owner/repo`, `owner/repo@ref`, and full
GitHub URLs.

### WASM runtime

`WasmRuntime` reads a `.wasm` file out of the VFS, compiles it (caching the
compiled module by the content hash of its bytes, so a re-run never
recompiles), and runs it under a WASI preview1 shim.

WASI calls are synchronous but the VFS is async, so before a run the runtime
snapshots each preopened VFS subtree into an in-memory synchronous `WasiFS`,
the program runs against that, and changed files are written back to the VFS
afterwards (unless `writeback: false`). The working set of a clone-and-run fits
in RAM comfortably, so this is both simple and correct for standard
`wasm32-wasi` binaries. stdout/stderr are captured and can also stream live to a
callback. Command modules (`_start`) and reactor modules (`_initialize`) are
both handled.

### ES module loader

`ModuleLoader` imports JavaScript that lives in the VFS, in memory, with no
server. It reads a module, scans its imports (skipping anything inside strings
and comments), resolves relative and absolute specifiers against the VFS
(trying as-is, then `.js`, `.mjs`, `/index.js`), recursively links the
dependency graph bottom-up, rewrites each specifier to the dependency's
in-memory URL, and hands the entry URL to the platform's native `import()`. In
a browser that URL is a `blob:`; in Node it is a `data:` URL. Bare specifiers
are left alone unless you map them through `externals` (for example to a CDN
URL). Re-importing an unchanged module reuses its URL; `invalidate(path)`
forces a relink after an edit.

The graph must be acyclic; a cycle throws a clear error rather than breaking
silently.

## Public API

`createSubstrate(options)` returns a `Substrate` handle.

Options: `persist` (IndexedDB-backed root, default false), `root` (mountpoint,
default `/`), `dirs` (dirs to pre-create), `cache` (`true` | `false` |
`{ maxBytes, dbName }`), `net` (`{ corsProxy, retries, timeoutMs }`), `git`
(`{ provider: 'auto'|'jsdelivr'|'github', concurrency, useProxy }`), `wasm`
(`{ cache }`), `modules` (`{ externals }`), `bus` (reuse an `EventBus`).

| Surface | Methods |
| --- | --- |
| `sb.fs` | the `VFS`: `readFile/writeFile/readText/writeText/read/stat/exists/list/mkdir/remove/rename/cp/walk/exportTree/importTree/mount/overlay` |
| `sb.git` | `clone(spec, opts)`, `pull(into, opts)`, `fetchFile(spec, path, opts)`, `ls(spec, opts)` |
| `sb.wasm` | `load(path)`, `compile(bytes, meta)`, `run(moduleOrPath, opts)`, `clearCache()` |
| `sb.modules` | `import(path, opts)`, `link(path, opts)`, `evaluate(src, opts)`, `invalidate(path)` |
| `sb.cache` | `{ objects: ObjectCache, repos: RepoCache }` |
| `sb` | `on(event, fn)`, `once(event, fn)`, `mount(path, backend)`, `overlay(lower, mount)`, `cloneWorkspace(spec, opts)`, `dispose()` |

`clone` options: `into`, `ref`, `filter(path) => bool`, `force`, `onProgress`,
`signal`. Returns `{ into, files, fetched, reused, bytesDownloaded, ms, ... }`.

`wasm.run` options: `args`, `env`, `preopens` (`{ guestDir: vfsPath }`),
`stdin`, `stdout(chunk)`, `stderr(chunk)`, `writeback`, `start`, `imports`.
Returns `{ exitCode, stdout, stderr, stdoutText, stderrText }`.

`cloneWorkspace(spec, { into, workdir })` clones then mounts a copy-on-write
overlay over the result, giving you an isolated, resettable edit layer in one
call. Returns the clone summary plus `{ workdir, overlay }` where
`overlay.reset()` discards edits and `overlay.isDirty()` reports state.

### Events

Subscribe with `sb.on(name, fn)`. The bus supports `'*'` for everything.

- `git:progress` `{ phase: 'resolve'|'list'|'diff'|'fetch'|'write'|'done', ... }`
- `wasm:compile` / `wasm:start` / `wasm:stdout` / `wasm:stderr` / `wasm:exit` / `wasm:error`
- `module:link` / `module:import`
- `fs:change` / `fs:mount` / `fs:unmount`
- `cache:*`

## Run the demo

`examples/ide.html` is a bare test harness (not a real UI) that boots the
kernel, clones a repo, runs an embedded wasm over the VFS, and imports a module
from the VFS. Serve the repo root over HTTP and open it:

```sh
python3 -m http.server 8080
# open http://localhost:8080/examples/ide.html
```

It needs to be served (ES modules do not load from `file://`). Any static host
works, including GitHub Pages.

## Tests

```sh
node test/run.mjs
```

The suites cover the VFS and overlay semantics, the git client and cache
(against the real network), the WASI shim and runtime (against real
`wasm32-wasi` binaries), the module loader, and a full end-to-end pass through
`createSubstrate`.

## Notes and limitations

- Designed browser-first but runs in Node for testing. In Node, in-memory
  modules use `data:` URLs because Node's loader will not import `blob:`.
- `clone` fetches the tree at a ref, not git history; a `depth` option is
  accepted and ignored.
- Some hosts need a CORS proxy for raw file bytes. Set `net.corsProxy` and
  `git.useProxy`.
- The module loader's dependency graph must be acyclic.
- WASI coverage targets what a typical clang/rust `wasm32-wasi` program needs.
  Rare calls return `ENOSYS` rather than trapping.

## License

GPL-2.0-only.
