/**
 * BORK IDBFS
 * IndexedDB-backed filesystem. Persistent across page reloads.
 * Used for /home/user and /packages.
 * Falls back gracefully to in-memory if IDB is unavailable (e.g. private browsing).
 */
export class IDBFS {
  constructor(dbName = 'bork-fs', storeName = 'inodes') {
    this._dbName    = dbName;
    this._storeName = storeName;
    this._db        = null;
    this._mem       = new Map(); // fallback in-memory store
    this._nextInode = 500000;   // IDB inode range
    this._ready     = false;
  }

  async open() {
    try {
      this._db = await this._openDB();
      this._ready = true;
      // Ensure root inode exists
      const root = await this._dbGet(this._rootKey());
      if (!root) {
        const now = Date.now();
        await this._dbPut(this._rootKey(), { inode: this._nextInode, type: 'dir', name: '', mode: 0o755, ctime: now, mtime: now, atime: now, children: {} });
      }
    } catch {
      // IDB unavailable — use pure memory fallback, still works
      this._ready = true;
      const now = Date.now();
      this._mem.set(this._rootKey(), { inode: this._nextInode, type: 'dir', name: '', mode: 0o755, ctime: now, mtime: now, atime: now, children: {} });
    }
    return this;
  }

  getRootInode() { return this._nextInode; }

  async stat(inode) {
    const node = await this._get(inode);
    if (!node) throw new Error(`IDBFS: inode ${inode} not found`);
    const dataLen = node.data ? (typeof node.data === 'string' ? node.data.length : node.data.byteLength ?? node.data.length) : 0;
    return { inode, type: node.type, size: dataLen, mode: node.mode ?? 0o644, ctime: node.ctime, mtime: node.mtime, atime: node.atime };
  }

  async readdir(inode) {
    const node = await this._get(inode);
    if (!node || node.type !== 'dir') throw new Error('IDBFS: not a directory');
    return Object.entries(node.children ?? {}).map(([name, childInode]) => {
      return this._get(childInode).then(child => ({ name, inode: childInode, type: child?.type ?? 'file' }));
    }).reduce(async (acc, p) => [...await acc, await p], Promise.resolve([]));
  }

  async read(inode, offset = 0, length = Infinity) {
    const node = await this._get(inode);
    if (!node || node.type !== 'file') throw new Error('IDBFS: not a file');
    node.atime = Date.now();
    await this._put(inode, node);
    let bytes = node.data instanceof Uint8Array ? node.data
              : node.data ? new TextEncoder().encode(node.data) : new Uint8Array(0);
    return bytes.slice(offset, length === Infinity ? undefined : offset + length);
  }

  async write(inode, offset, data) {
    const node = await this._get(inode);
    if (!node || node.type !== 'file') throw new Error('IDBFS: not a file');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let existing = node.data instanceof Uint8Array ? node.data
                 : node.data ? new TextEncoder().encode(node.data) : new Uint8Array(0);
    const needed = offset + bytes.length;
    if (needed > existing.length) {
      const grown = new Uint8Array(needed);
      grown.set(existing);
      existing = grown;
    }
    existing.set(bytes, offset);
    node.data = existing;
    node.mtime = Date.now();
    await this._put(inode, node);
    return bytes.length;
  }

  async create(parentInode, name, type = 'file', mode = 0o644) {
    const parent = await this._get(parentInode);
    if (!parent || parent.type !== 'dir') throw new Error('IDBFS: parent not a directory');
    if (parent.children[name] !== undefined) return parent.children[name];
    const inode = this._nextInode++;
    const now   = Date.now();
    await this._put(inode, { inode, type, name, mode, ctime: now, mtime: now, atime: now, data: type === 'file' ? new Uint8Array(0) : null, children: type === 'dir' ? {} : null });
    parent.children[name] = inode;
    parent.mtime = now;
    await this._put(parentInode, parent);
    return inode;
  }

  async unlink(parentInode, name) {
    const parent = await this._get(parentInode);
    if (!parent || parent.type !== 'dir') throw new Error('IDBFS: parent not a directory');
    const childInode = parent.children[name];
    if (childInode === undefined) throw new Error(`IDBFS: ${name} not found`);
    delete parent.children[name];
    parent.mtime = Date.now();
    await this._put(parentInode, parent);
    await this._del(childInode);
  }

  async rename(oldParentInode, oldName, newParentInode, newName) {
    const oldParent = await this._get(oldParentInode);
    const newParent = await this._get(newParentInode);
    if (!oldParent || !newParent) throw new Error('IDBFS: rename: invalid parents');
    const inode = oldParent.children[oldName];
    if (inode === undefined) throw new Error(`IDBFS: ${oldName} not found`);
    delete oldParent.children[oldName];
    newParent.children[newName] = inode;
    await this._put(oldParentInode, oldParent);
    await this._put(newParentInode, newParent);
    const node = await this._get(inode);
    if (node) { node.name = newName; await this._put(inode, node); }
  }

  // ── IDB internals ────────────────────────────────────────────────────────

  _rootKey() { return `inode:${this._nextInode}`; }
  _key(inode) { return `inode:${inode}`; }

  async _get(inode) {
    if (this._db) {
      return new Promise((res, rej) => {
        const tx = this._db.transaction(this._storeName, 'readonly');
        const req = tx.objectStore(this._storeName).get(this._key(inode));
        req.onsuccess = () => res(req.result ?? null);
        req.onerror = () => rej(req.error);
      });
    }
    return this._mem.get(this._key(inode)) ?? null;
  }

  async _put(inode, node) {
    if (this._db) {
      return new Promise((res, rej) => {
        const tx = this._db.transaction(this._storeName, 'readwrite');
        const req = tx.objectStore(this._storeName).put(node, this._key(inode));
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    }
    this._mem.set(this._key(inode), node);
  }

  async _del(inode) {
    if (this._db) {
      return new Promise((res, rej) => {
        const tx = this._db.transaction(this._storeName, 'readwrite');
        const req = tx.objectStore(this._storeName).delete(this._key(inode));
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    }
    this._mem.delete(this._key(inode));
  }

  async _dbGet(key) {
    return new Promise((res, rej) => {
      const tx = this._db.transaction(this._storeName, 'readonly');
      const req = tx.objectStore(this._storeName).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
  }

  async _dbPut(key, value) {
    return new Promise((res, rej) => {
      const tx = this._db.transaction(this._storeName, 'readwrite');
      const req = tx.objectStore(this._storeName).put(value, key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  _openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this._storeName)) {
          db.createObjectStore(this._storeName);
        }
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }
}
