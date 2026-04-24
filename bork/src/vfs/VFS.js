/**
 * BORK VFS
 * Path router. Maintains mount table. Resolves paths to (backend, inode) pairs.
 * Everything in BORK is a file — /dev/tty0, /proc/meminfo, /home/user/foo.txt.
 */
export class VFS {
  constructor() {
    this._mounts   = []; // [{ mountpoint, backend, fstype }] sorted longest first
    this._backends = new Map(); // name → BackendClass
    this._dec      = new TextDecoder();
  }

  // ── Mount management ─────────────────────────────────────────────────────

  mount(mountpoint, backend, fstype = 'unknown') {
    // Remove existing mount at same point
    this._mounts = this._mounts.filter(m => m.mountpoint !== mountpoint);
    this._mounts.push({ mountpoint, backend, fstype });
    this._mounts.sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  }

  registerBackend(name, BackendClass) {
    this._backends.set(name, BackendClass);
  }

  mounts() {
    return this._mounts.map(m => ({ target: m.mountpoint, fstype: m.fstype }));
  }

  // ── Path resolution ──────────────────────────────────────────────────────

  /** Resolve a path to { backend, inode } */
  async resolve(path) {
    path = this._normalize(path);
    const mount = this._findMount(path);
    if (!mount) throw new Error(`VFS: no mount for ${path}`);

    if (path === mount.mountpoint || (mount.mountpoint === '/' && path === '/')) {
      return { backend: mount.backend, inode: mount.backend.getRootInode() };
    }

    // Walk from mount root
    const rel = path.slice(mount.mountpoint === '/' ? 1 : mount.mountpoint.length + 1);
    const parts = rel.split('/').filter(Boolean);
    let inode = mount.backend.getRootInode();
    let currentBackend = mount.backend;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const entries = await currentBackend.readdir(inode);
      const entry = entries.find(e => e.name === part);
      if (!entry) throw new Error(`VFS: no such file or directory: ${path}`);
      // Check if child path has its own mount
      const childPath = mount.mountpoint === '/'
        ? '/' + parts.slice(0, i + 1).join('/')
        : mount.mountpoint + '/' + parts.slice(0, i + 1).join('/');
      const childMount = this._mounts.find(m => m.mountpoint === childPath);
      if (childMount) {
        inode = childMount.backend.getRootInode();
        currentBackend = childMount.backend;
      } else {
        inode = entry.inode;
      }
    }
    return { backend: currentBackend, inode };
  }

  /** Resolve parent and return { backend, parentInode, name } */
  async resolveParent(path) {
    path = this._normalize(path);
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('VFS: cannot create root');
    const name = parts[parts.length - 1];
    const parentPath = '/' + parts.slice(0, -1).join('/');
    const { backend, inode } = await this.resolve(parentPath || '/');
    return { backend, parentInode: inode, name };
  }

  // ── High-level ops ───────────────────────────────────────────────────────

  async stat(path) {
    const { backend, inode } = await this.resolve(path);
    return backend.stat(inode);
  }

  async readdir(path) {
    const { backend, inode } = await this.resolve(path);
    return backend.readdir(inode);
  }

  async read(path, offset = 0, length = Infinity) {
    const { backend, inode } = await this.resolve(path);
    const node = await backend.stat(inode);
    if (node.type === 'device') {
      const driver = backend.getDriver?.(inode);
      if (driver) return driver.read(length);
    }
    return backend.read(inode, offset, length);
  }

  async readText(path) {
    const bytes = await this.read(path);
    return this._dec.decode(bytes);
  }

  async write(path, data, offset = 0) {
    const { backend, inode } = await this.resolve(path);
    const node = await backend.stat(inode);
    if (node.type === 'device') {
      const driver = backend.getDriver?.(inode);
      if (driver) return driver.write(data);
    }
    return backend.write(inode, offset, data);
  }

  async mkdir(path, mode = 0o755) {
    path = this._normalize(path);
    // Check if exists
    try {
      const s = await this.stat(path);
      if (s.type === 'dir') return;
    } catch {}
    const { backend, parentInode, name } = await this.resolveParent(path);
    return backend.create(parentInode, name, 'dir', mode);
  }

  async createFile(path, mode = 0o644) {
    const { backend, parentInode, name } = await this.resolveParent(path);
    return backend.create(parentInode, name, 'file', mode);
  }

  async unlink(path) {
    const { backend, parentInode, name } = await this.resolveParent(path);
    return backend.unlink(parentInode, name);
  }

  async exists(path) {
    try { await this.stat(path); return true; }
    catch { return false; }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _normalize(path) {
    if (!path.startsWith('/')) path = '/' + path;
    const parts = [];
    for (const p of path.split('/')) {
      if (p === '..') parts.pop();
      else if (p && p !== '.') parts.push(p);
    }
    return '/' + parts.join('/');
  }

  _findMount(path) {
    for (const m of this._mounts) {
      if (path === m.mountpoint) return m;
      if (m.mountpoint === '/') return m;
      if (path.startsWith(m.mountpoint + '/')) return m;
    }
    return null;
  }
}
