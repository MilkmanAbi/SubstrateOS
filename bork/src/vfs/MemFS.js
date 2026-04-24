/**
 * BORK MemFS
 * Pure in-memory filesystem. Fast, ephemeral (dies on page reload).
 * Used for /tmp, /dev, /lib, /mnt.
 */
export class MemFS {
  constructor() {
    this._nextInode = 1;
    this._inodes    = new Map(); // inode → { type, name, mode, ctime, data?, children }
    this._root      = this._makeInode('dir', 'root', 0o755);
  }

  getRootInode() { return this._root; }

  _makeInode(type, name, mode = 0o644) {
    const inode = this._nextInode++;
    const now   = Date.now();
    this._inodes.set(inode, {
      type, name, mode,
      ctime: now, mtime: now, atime: now,
      data: type === 'file' ? new Uint8Array(0) : null,
      children: type === 'dir' ? new Map() : null, // name→inode
    });
    return inode;
  }

  async stat(inode) {
    const node = this._inodes.get(inode);
    if (!node) throw new Error(`MemFS: inode ${inode} not found`);
    return {
      inode, type: node.type, mode: node.mode,
      size: node.data?.length ?? 0,
      ctime: node.ctime, mtime: node.mtime, atime: node.atime,
    };
  }

  async readdir(inode) {
    const node = this._inodes.get(inode);
    if (!node || node.type !== 'dir') throw new Error('MemFS: not a directory');
    return Array.from(node.children.entries()).map(([name, childInode]) => {
      const child = this._inodes.get(childInode);
      return { name, inode: childInode, type: child?.type ?? 'file' };
    });
  }

  async read(inode, offset = 0, length = Infinity) {
    const node = this._inodes.get(inode);
    if (!node || node.type !== 'file') throw new Error('MemFS: not a file');
    node.atime = Date.now();
    const data = node.data;
    return data.slice(offset, length === Infinity ? undefined : offset + length);
  }

  async write(inode, offset, data) {
    const node = this._inodes.get(inode);
    if (!node || node.type !== 'file') throw new Error('MemFS: not a file');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const needed = offset + bytes.length;
    if (needed > node.data.length) {
      const grown = new Uint8Array(needed);
      grown.set(node.data);
      node.data = grown;
    }
    node.data.set(bytes, offset);
    node.mtime = Date.now();
    return bytes.length;
  }

  async create(parentInode, name, type = 'file', mode = 0o644) {
    const parent = this._inodes.get(parentInode);
    if (!parent || parent.type !== 'dir') throw new Error('MemFS: parent not a directory');
    if (parent.children.has(name)) return parent.children.get(name);
    const inode = this._makeInode(type, name, mode);
    parent.children.set(name, inode);
    parent.mtime = Date.now();
    return inode;
  }

  async unlink(parentInode, name) {
    const parent = this._inodes.get(parentInode);
    if (!parent || parent.type !== 'dir') throw new Error('MemFS: parent not a directory');
    const childInode = parent.children.get(name);
    if (childInode === undefined) throw new Error(`MemFS: ${name} not found`);
    parent.children.delete(name);
    this._inodes.delete(childInode);
    parent.mtime = Date.now();
  }

  async rename(oldParentInode, oldName, newParentInode, newName) {
    const oldParent = this._inodes.get(oldParentInode);
    const newParent = this._inodes.get(newParentInode);
    if (!oldParent || !newParent) throw new Error('MemFS: rename: invalid parents');
    const inode = oldParent.children.get(oldName);
    if (inode === undefined) throw new Error(`MemFS: ${oldName} not found`);
    oldParent.children.delete(oldName);
    newParent.children.set(newName, inode);
    const node = this._inodes.get(inode);
    if (node) node.name = newName;
  }

  /** Register a device driver at a given inode (for /dev/* entries) */
  registerDevice(parentInode, name, driver) {
    const inode = this._nextInode++;
    const now   = Date.now();
    this._inodes.set(inode, {
      type: 'device', name, mode: 0o666,
      ctime: now, mtime: now, atime: now,
      data: null, children: null,
      driver,
    });
    const parent = this._inodes.get(parentInode);
    if (parent?.children) parent.children.set(name, inode);
    return inode;
  }

  getDriver(inode) {
    return this._inodes.get(inode)?.driver ?? null;
  }

  hasChild(parentInode, name) {
    return this._inodes.get(parentInode)?.children?.has(name) ?? false;
  }

  getChild(parentInode, name) {
    return this._inodes.get(parentInode)?.children?.get(name) ?? null;
  }
}
