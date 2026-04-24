/**
 * BORK — Browser-Oriented Runtime Kernel v2.0
 * createBORK() is the only public entry. Everything else is internal.
 */
import { MemoryManager }  from './memory/MemoryManager.js';
import { TTYDriver }       from './devices/TTYDriver.js';
import { MemFS }           from './vfs/MemFS.js';
import { IDBFS }           from './vfs/IDBFS.js';
import { ProcFS }          from './vfs/ProcFS.js';
import { ZipFS }           from './vfs/ZipFS.js';
import { VFS }             from './vfs/VFS.js';
import { ProcessManager }  from './process/ProcessManager.js';
import { Pipe }            from './ipc/Pipe.js';
import { NetDevice }       from './net/NetDevice.js';
import { ShellParser, expandVars } from './shell/ShellParser.js';

export const VERSION = '2.0.0';

export async function createBORK(cfg = {}) {
  const k = new BORKKernel(cfg);
  await k._boot();
  return k;
}

class BORKKernel {
  constructor(cfg) {
    this._cfg = {
      poolMB:         256,
      maxPoolMB:      2048,
      defaultSoftMB:  32,
      defaultHardMB:  128,
      idbName:        'bork-v2',
      networkEnabled: true,
      corsProxy:      '',
      // memory mode config
      profile:        null,  // 'mobile'|'desktop'|'aggressive'
      maxLimitMB:     null,  // manual limit
      pgs:            false, // --platform-guaranteed-stability
      ...cfg,
    };
    this.ready = false;
    this.startTime = Date.now();
    this.version = VERSION;

    this.mm  = new MemoryManager({ poolMB: this._cfg.poolMB, maxPoolMB: this._cfg.maxPoolMB });

    // Apply memory configuration
    // Priority: pgs > maxLimitMB > profile > default(desktop)
    // Profile must be set before pm/vfs/etc are created so DMU can wire properly.
    {
      const { pgs, maxLimitMB, profile } = this._cfg;
      if (pgs) {
        this.mm.setPGS();
      } else if (maxLimitMB) {
        this.mm.setLimit(maxLimitMB);
      } else if (profile) {
        this.mm.profile(profile);
      } else {
        this.mm.profile('desktop');  // sane default — DMU + velocity armed
      }
    }

    // Wire DMU process-kill events back to pm once pm is created
    // (done post-boot since pm isn't ready here)
    this.pm  = new ProcessManager();
    this.tty = new TTYDriver();
    this.vfs = new VFS();
    this.net = new NetDevice({ corsProxy: this._cfg.corsProxy });

    this._memfs  = new MemFS();
    this._procfs = new ProcFS();
    this._idbHome = null;
    this._idbPkg  = null;
    this._zipMountCount = 0;
    this._activePipes   = new Map(); // id → Pipe

    // Wire DMU process-kill events to ProcessManager
    if (this.mm.dmu) {
      this.mm.dmu.onEvict((key, bytes, reason) => {
        if (reason === 'process-kill') {
          const pid = parseInt(key);
          if (!isNaN(pid) && pid > 1) this.pm.kill(pid, 'SIGTERM');
        }
      });
    }

    this.sys = this._buildSys();
  }

  async _boot() {
    // 1. Root MemFS
    this.vfs.mount('/', this._memfs, 'memfs');

    // 2. Directory tree
    const root = this._memfs.getRootInode();
    for (const d of ['dev','home','mnt','tmp','lib','proc','run','var']) {
      await this._memfs.create(root, d, 'dir', 0o755);
    }
    const homeInode = this._memfs.getChild(root, 'home');
    await this._memfs.create(homeInode, 'user', 'dir', 0o755);
    const libInode = this._memfs.getChild(root, 'lib');
    await this._memfs.create(libInode, 'dart', 'dir', 0o755);
    const varInode = this._memfs.getChild(root, 'var');
    await this._memfs.create(varInode, 'log', 'dir', 0o755);

    // 3. Devices
    const devInode = this._memfs.getChild(root, 'dev');
    this._memfs.registerDevice(devInode, 'tty0', this.tty);
    this._memfs.registerDevice(devInode, 'null', {
      async write(d) { return typeof d === 'string' ? d.length : d.byteLength ?? d.length; },
      async read(l)  { return new Uint8Array(l); },
      ioctl()        { return null; },
    });
    this._memfs.registerDevice(devInode, 'random', {
      async write(d) { return typeof d === 'string' ? d.length : d.byteLength ?? d.length; },
      async read(l)  { const b = new Uint8Array(l); crypto.getRandomValues(b); return b; },
      ioctl()        { return null; },
    });
    if (this._cfg.networkEnabled) {
      this._memfs.registerDevice(devInode, 'net', this.net);
    }
    // /dev/zero
    this._memfs.registerDevice(devInode, 'zero', {
      async write(d) { return 0; },
      async read(l)  { return new Uint8Array(l); }, // zeros
      ioctl()        { return null; },
    });

    // 4. ProcFS
    this._procfs.attach(this);
    this.vfs.mount('/proc', this._procfs, 'procfs');

    // 5. IDB-FS async mounts
    this._idbHome = new IDBFS(this._cfg.idbName + '-home');
    this._idbPkg  = new IDBFS(this._cfg.idbName + '-pkg');
    this._idbHome.open().then(() => this.vfs.mount('/home/user', this._idbHome, 'idbfs')).catch(() => {});
    this._idbPkg.open().then(() => this.vfs.mount('/packages', this._idbPkg, 'idbfs')).catch(() => {});

    // 6. Packages dir (will be overridden by IDB mount)
    const mntInode = this._memfs.getChild(root, 'mnt');
    // already created above

    this.ready = true;
  }

  _buildSys() {
    const k = this;

    // ── Process ──────────────────────────────────────────────────────────────
    const spawnProc = async (opts = {}) => {
      const soft = opts.softMB ?? k._cfg.defaultSoftMB;
      const hard = opts.hardMB ?? k._cfg.defaultHardMB;
      const handle = k.pm.spawn({ ...opts, softMB: soft, hardMB: hard });
      k.mm.registerPid(handle.pid, soft, hard);
      // Default env
      const defaultEnv = { HOME: '/home/user', PATH: '/bin:/usr/bin', USER: 'user',
                           SHELL: '/bin/bsh', TERM: 'xterm-256color', BORK_VERSION: VERSION };
      for (const [kk, v] of Object.entries(defaultEnv)) k.mm.setEnv(handle.pid, kk, v);
      for (const [kk, v] of Object.entries(opts.env ?? {})) k.mm.setEnv(handle.pid, kk, v);
      return handle;
    };

    return {
      // ── Process ────────────────────────────────────────────────────────────
      spawn: spawnProc,

      exit: (pid, code = 0) => { k.pm.exit(pid, code); k.mm.freePid(pid); },

      kill: async (pid, signal = 'SIGTERM') => { k.pm.kill(pid, signal); },

      wait: (pid) => k.pm.wait(pid),

      ps: () => k.pm.list(),

      signal: (pid, signame, handler) => k.pm.setSignalHandler(pid, signame, handler),

      // ── Filesystem ─────────────────────────────────────────────────────────
      open: async (pid, path, flags = 'r') => {
        await k.vfs.stat(path); // validate
        const fd = k.pm.openFd(pid, { path, flags, offset: 0 });
        return fd;
      },

      read: async (pid, fd, length = 65536) => {
        if (fd === 0) {
          const stdin = k.pm.getFd(pid, 0);
          if (stdin && typeof stdin.read === 'function') return stdin.read(length);
          return k.tty.read(length);
        }
        const res = k.pm.getFd(pid, fd);
        if (!res) throw new Error(`BORK: bad fd ${fd}`);
        if (typeof res.read === 'function') return res.read(length); // Pipe
        const data = await k.vfs.read(res.path, res.offset, length);
        res.offset += data.length;
        return data;
      },

      write: async (pid, fd, data) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (fd === 1 || fd === 2) {
          const out = k.pm.getFd(pid, fd);
          if (out && typeof out.write === 'function') return out.write(bytes); // Pipe
          return k.tty.write(data);
        }
        const res = k.pm.getFd(pid, fd);
        if (!res) throw new Error(`BORK: bad fd ${fd}`);
        if (typeof res.write === 'function') return res.write(bytes); // Pipe
        const written = await k.vfs.write(res.path, bytes, res.offset);
        if (res.flags !== 'a') res.offset += written;
        return written;
      },

      close: (pid, fd) => k.pm.closeFd(pid, fd),

      stat:    (path)       => k.vfs.stat(path),
      readdir: (path)       => k.vfs.readdir(path),
      mkdir:   (path, mode) => k.vfs.mkdir(path, mode),
      unlink:  (path)       => k.vfs.unlink(path),
      exists:  (path)       => k.vfs.exists(path),

      rename: async (oldPath, newPath) => {
        const { backend: ob, parentInode: op, name: on } = await k.vfs.resolveParent(oldPath);
        const { backend: nb, parentInode: np, name: nn } = await k.vfs.resolveParent(newPath);
        if (ob === nb) return ob.rename(op, on, np, nn);
        throw new Error('rename: cross-device not supported');
      },

      chmod: async (path, mode) => {
        // MemFS/IDBFS don't enforce permissions but store them
        const { backend, inode } = await k.vfs.resolve(path);
        if (backend._inodes) { const n = backend._inodes.get(inode); if (n) n.mode = mode; }
      },

      readTextFile: (path) => k.vfs.readText(path),

      writeFile: async (path, data) => {
        const exists = await k.vfs.exists(path);
        if (!exists) await k.vfs.createFile(path);
        return k.vfs.write(path, data, 0);
      },

      appendFile: async (path, data) => {
        const exists = await k.vfs.exists(path);
        if (!exists) await k.vfs.createFile(path);
        try {
          const stat = await k.vfs.stat(path);
          return k.vfs.write(path, data, stat.size);
        } catch { return k.vfs.write(path, data, 0); }
      },

      readFile: (path) => k.vfs.read(path),

      mount: async (target, fstype, opts = {}) => {
        const BC = k.vfs._backends.get(fstype);
        if (!BC) throw new Error(`BORK: unknown fstype ${fstype}`);
        const backend = new BC(opts);
        if (backend.open) await backend.open();
        await k.vfs.mkdir(target);
        k.vfs.mount(target, backend, fstype);
        return target;
      },

      mountZip: async (target, buffer) => {
        const zfs = new ZipFS();
        await zfs.load(buffer);
        await k.vfs.mkdir(target);
        k.vfs.mount(target, zfs, 'zipfs');
        k._zipMountCount++;
        return { target, files: zfs.fileCount, bytes: zfs.byteCount };
      },

      // ── I/O ────────────────────────────────────────────────────────────────
      print: async (pid, str) => {
        const stdout = k.pm.getFd(pid, 1);
        if (stdout && typeof stdout.write === 'function') return stdout.write(str);
        return k.tty.write(str);
      },

      readline: async (pid) => {
        const stdin = k.pm.getFd(pid, 0);
        if (stdin && typeof stdin.readLine === 'function') return stdin.readLine();
        return k.tty.readline();
      },

      // ── Memory ─────────────────────────────────────────────────────────────
      meminfo: () => k.mm.meminfo(),
      malloc:  (pid, size) => k.mm.malloc(pid, size),
      mallocSync: (pid, size) => k.mm.mallocSync(pid, size),
      free:    (pid, ptr)  => k.mm.free(pid, ptr),
      pidUsage: (pid) => k.mm.pidUsage(pid),

      // Named memory profile — arms MemoryVelocity + DMU
      memProfile: (name) => k.mm.profile(name),

      // Manual limit — dev owns this, velocity inert, DMU logs
      // @param {number} maxMB
      memSetLimit: (maxMB) => k.mm.setLimit(maxMB),

      // --platform-guaranteed-stability — BORK backs off completely
      memPGS: () => k.mm.setPGS(),

      // Subsystem direct access for power users
      get memVelocity() { return k.mm.velocity; },
      get memDMU()      { return k.mm.dmu; },

      // Register an object for DMU tracking
      dmuRegister: (key, opts) => k.mm.dmu?.register(key, opts),
      dmuTouch:    (key)       => k.mm.dmu?.touch(key),
      dmuEnsureHot:(key)       => k.mm.dmu?.ensureHot(key) ?? Promise.resolve(false),
      dmuUnregister:(key)      => k.mm.dmu?.unregister(key),

      // ── TTY ────────────────────────────────────────────────────────────────
      ioctl: (fd, req, arg) => {
        if (fd === 0 || fd === 1 || fd === 2) return k.tty.ioctl(req, arg);
        throw new Error(`BORK: ioctl on non-TTY fd ${fd}`);
      },

      // ── Pipes ──────────────────────────────────────────────────────────────
      pipe: () => {
        const p = new Pipe();
        k._activePipes.set(p.id, p);
        return p;
      },

      // ── Network ────────────────────────────────────────────────────────────
      fetch: (url, opts) => {
        if (!k._cfg.networkEnabled) throw new Error('BORK: network disabled in config');
        return k.net.fetch(url, opts);
      },

      // ── CWD ────────────────────────────────────────────────────────────────
      getCwd: (pid) => k.pm.getCwd(pid),
      setCwd: (pid, cwd) => k.pm.setCwd(pid, cwd),

      // ── Env ────────────────────────────────────────────────────────────────
      setEnv: (pid, key, value) => {
        k.mm.setEnv(pid, key, value);
        k.pm.setEnvProc(pid, key, value);
      },
      getEnv: (pid, key)  => k.mm.getEnv(pid, key) ?? k.pm.getEnvProc(pid, key),
      getEnvAll: (pid)    => ({ ...k.mm.getEnvAll(pid), ...k.pm.getEnvAllProc(pid) }),
    };
  }

  get vfsExtensions() {
    return {
      registerBackend: (name, BC) => this.vfs.registerBackend(name, BC),
      mounts: () => this.vfs.mounts(),
    };
  }

  get devExtensions() {
    return {
      register: (path, driver) => {
        const devInode = this._memfs.getChild(this._memfs.getRootInode(), 'dev');
        const name = path.split('/').pop();
        this._memfs.registerDevice(devInode, name, driver);
      },
    };
  }

  get shell() {
    return { parse: (raw, env) => ShellParser.parse(raw, env), expandVars };
  }
}
