/**
 * BORK Pipe
 * Bidirectional IPC channel between processes.
 * One end writes, the other reads. Supports backpressure via buffer cap.
 * Used to implement shell pipes: cmd1 | cmd2 | cmd3
 */
export class Pipe {
  constructor({ capacity = 65536 } = {}) {
    this._buf      = [];         // queued Uint8Array chunks
    this._size     = 0;         // total bytes buffered
    this._capacity = capacity;  // backpressure limit
    this._closed   = false;     // write end closed?
    this._readers  = [];        // pending read resolve callbacks
    this._enc      = new TextEncoder();
    this._dec      = new TextDecoder();
    this.id        = Pipe._seq = (Pipe._seq ?? 0) + 1;
  }

  // ── Write side ──────────────────────────────────────────────────────────

  write(data) {
    if (this._closed) throw new Error('Pipe: write to closed pipe');
    const bytes = typeof data === 'string' ? this._enc.encode(data) : data;
    this._buf.push(bytes);
    this._size += bytes.length;
    // Wake any pending reader
    if (this._readers.length) {
      const resolve = this._readers.shift();
      resolve(this._drain());
    }
    return bytes.length;
  }

  close() {
    this._closed = true;
    // Wake all pending readers with whatever is left (or empty if nothing)
    while (this._readers.length) {
      const resolve = this._readers.shift();
      resolve(this._drain());
    }
  }

  // ── Read side ───────────────────────────────────────────────────────────

  async read(maxBytes = 65536) {
    if (this._size > 0) return this._drain(maxBytes);
    if (this._closed) return new Uint8Array(0); // EOF
    return new Promise(resolve => this._readers.push(resolve));
  }

  async readLine() {
    const chunks = [];
    while (true) {
      const chunk = await this.read();
      if (chunk.length === 0) break; // EOF
      // Search for newline
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) { // \n
          chunks.push(chunk.slice(0, i));
          // Put remainder back
          if (i + 1 < chunk.length) {
            this._buf.unshift(chunk.slice(i + 1));
            this._size += chunk.length - i - 1;
          }
          return this._dec.decode(this._concat(chunks));
        }
      }
      chunks.push(chunk);
    }
    return this._dec.decode(this._concat(chunks));
  }

  async readAll() {
    const chunks = [];
    while (true) {
      const chunk = await this.read();
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    return this._dec.decode(this._concat(chunks));
  }

  get bytesAvailable() { return this._size; }
  get isClosed()       { return this._closed && this._size === 0; }

  // ── Internal ─────────────────────────────────────────────────────────────

  _drain(maxBytes = Infinity) {
    if (!this._buf.length) return new Uint8Array(0);
    if (maxBytes === Infinity) {
      const out = this._concat(this._buf);
      this._buf = []; this._size = 0;
      return out;
    }
    const chunks = []; let taken = 0;
    while (this._buf.length && taken < maxBytes) {
      const chunk = this._buf[0];
      if (taken + chunk.length <= maxBytes) {
        chunks.push(chunk); this._buf.shift(); taken += chunk.length; this._size -= chunk.length;
      } else {
        const part = chunk.slice(0, maxBytes - taken);
        chunks.push(part); this._buf[0] = chunk.slice(maxBytes - taken);
        this._size -= part.length; taken += part.length; break;
      }
    }
    return this._concat(chunks);
  }

  _concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total); let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }
}

/**
 * Create a connected pipe pair: [readEnd, writeEnd]
 * Writer writes to writeEnd, reader reads from readEnd.
 */
export function makePipe() {
  const p = new Pipe();
  return p; // single object with both sides — caller manages direction
}
