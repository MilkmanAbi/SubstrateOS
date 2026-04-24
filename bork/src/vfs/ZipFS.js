/**
 * BORK ZipFS
 * Mount a .zip ArrayBuffer as a read-only filesystem.
 * Supports STORED and DEFLATE. Uses native DecompressionStream (no deps).
 */
export class ZipFS {
  constructor() {
    this._entries   = [];   // parsed central directory
    this._rootInode = 600000;
    this._inodeMap  = new Map(); // path → inode
    this._inodeEntries = new Map(); // inode → entry
    this._tree      = new Map(); // parentPath → [childName, ...]
    this._nextInode = 600001;
  }

  async load(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this._bytes  = bytes;
    this._parse(bytes);
    return this;
  }

  getRootInode() { return this._rootInode; }

  async stat(inode) {
    if (inode === this._rootInode) return { inode, type: 'dir', size: 0, mode: 0o555, ctime: Date.now(), mtime: Date.now(), atime: Date.now() };
    const entry = this._inodeEntries.get(inode);
    if (!entry) throw new Error(`ZipFS: inode ${inode} not found`);
    return { inode, type: entry.isDir ? 'dir' : 'file', size: entry.uncompressedSize, mode: entry.isDir ? 0o555 : 0o444, ctime: Date.now(), mtime: Date.now(), atime: Date.now() };
  }

  async readdir(inode) {
    let path = '';
    if (inode !== this._rootInode) {
      const entry = this._inodeEntries.get(inode);
      if (!entry || !entry.isDir) throw new Error('ZipFS: not a directory');
      path = entry.path;
    }
    const children = this._tree.get(path) ?? [];
    return children.map(name => {
      const childPath = path ? `${path}/${name}` : name;
      const childInode = this._inodeMap.get(childPath);
      const childEntry = this._inodeEntries.get(childInode);
      return { name, inode: childInode, type: childEntry?.isDir ? 'dir' : 'file' };
    });
  }

  async read(inode) {
    const entry = this._inodeEntries.get(inode);
    if (!entry || entry.isDir) throw new Error('ZipFS: not a file');
    return this._decompress(entry);
  }

  async write()  { throw new Error('ZipFS: read-only filesystem'); }
  async create() { throw new Error('ZipFS: read-only filesystem'); }
  async unlink() { throw new Error('ZipFS: read-only filesystem'); }
  async rename() { throw new Error('ZipFS: read-only filesystem'); }

  get fileCount() { return this._entries.filter(e => !e.isDir).length; }
  get byteCount()  { return this._bytes?.length ?? 0; }

  // ── Zip parsing ──────────────────────────────────────────────────────────

  _parse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Find End of Central Directory record
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('ZipFS: not a valid ZIP file');

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount  = view.getUint16(eocdOffset + 10, true);

    let offset = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const compression       = view.getUint16(offset + 10, true);
      const compressedSize    = view.getUint32(offset + 20, true);
      const uncompressedSize  = view.getUint32(offset + 24, true);
      const fileNameLength    = view.getUint16(offset + 28, true);
      const extraLength       = view.getUint16(offset + 30, true);
      const commentLength     = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const fileName          = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + fileNameLength));

      const isDir = fileName.endsWith('/');
      const path  = isDir ? fileName.slice(0, -1) : fileName;

      const inode = this._nextInode++;
      const entry = { path, isDir, compression, compressedSize, uncompressedSize, localHeaderOffset, inode };
      this._entries.push(entry);
      this._inodeMap.set(path, inode);
      this._inodeEntries.set(inode, entry);

      // Build tree
      const parts  = path.split('/');
      const parent = parts.slice(0, -1).join('/');
      if (!this._tree.has(parent)) this._tree.set(parent, []);
      if (!isDir || parts.length > 1) {
        const siblings = this._tree.get(parent);
        const name = parts[parts.length - 1];
        if (name && !siblings.includes(name)) siblings.push(name);
      }

      offset += 46 + fileNameLength + extraLength + commentLength;
    }
  }

  async _decompress(entry) {
    // Find local header to get actual data offset
    const view = new DataView(this._bytes.buffer, this._bytes.byteOffset, this._bytes.byteLength);
    const lo = entry.localHeaderOffset;
    const fileNameLen = view.getUint16(lo + 26, true);
    const extraLen    = view.getUint16(lo + 28, true);
    const dataOffset  = lo + 30 + fileNameLen + extraLen;
    const compData    = this._bytes.slice(dataOffset, dataOffset + entry.compressedSize);

    if (entry.compression === 0) return compData; // STORED
    if (entry.compression === 8) {
      // DEFLATE — use DecompressionStream
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compData);
      writer.close();
      const chunks = [];
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (value) chunks.push(value);
        done = d;
      }
      const out = new Uint8Array(entry.uncompressedSize);
      let pos = 0;
      for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
      return out;
    }
    throw new Error(`ZipFS: unsupported compression method ${entry.compression}`);
  }
}
