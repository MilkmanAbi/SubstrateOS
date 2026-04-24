/**
 * BORK TTYDriver
 * /dev/tty0 — ring buffer I/O bridge between kernel and BARK terminal UI.
 * Writes go into output buffer → BARK drains and renders.
 * Reads block until BARK pushes input.
 */
export class TTYDriver {
  constructor() {
    this._outBuf   = [];    // strings waiting to be drained by BARK
    this._inQueue  = [];    // lines pushed by BARK
    this._waiters  = [];    // resolve callbacks waiting for readline
    this._outputCb = null;  // BARK registers this to receive output signals
    this._enc      = new TextEncoder();
    this._dec      = new TextDecoder();
    this.settings  = { echo: true, canonical: true, cols: 80, rows: 24 };
    this.type      = 'device';
  }

  // ── Called by kernel / processes ─────────────────────────────────────────

  async write(data) {
    const str = typeof data === 'string' ? data : this._dec.decode(data);
    this._outBuf.push(str);
    if (this._outputCb) this._outputCb(str);
    return str.length;
  }

  async read(length = 4096) {
    if (this._inQueue.length) return this._enc.encode(this._inQueue.shift());
    return new Promise(resolve =>
      this._waiters.push(data => resolve(this._enc.encode(data))));
  }

  readline() {
    return new Promise(resolve => {
      if (this._inQueue.length) { resolve(this._inQueue.shift()); return; }
      this._waiters.push(resolve);
    });
  }

  ioctl(request, arg) {
    if (request === 'TIOCGWINSZ') return { cols: this.settings.cols, rows: this.settings.rows };
    if (request === 'TIOCSWINSZ') { Object.assign(this.settings, arg); return null; }
    if (request === 'TCGETA')     return { ...this.settings };
    if (request === 'TCSETA')     { Object.assign(this.settings, arg); return null; }
    throw new Error(`TTY: unknown ioctl ${request}`);
  }

  // ── Called by BARK ───────────────────────────────────────────────────────

  /** BARK registers a callback — called every time output arrives */
  onOutput(cb) { this._outputCb = cb; }

  /** BARK drains all pending output (for polling mode) */
  drainOutputText() {
    const text = this._outBuf.join('');
    this._outBuf = [];
    return text;
  }

  /** BARK pushes keyboard input */
  pushInput(str) {
    if (this._waiters.length) {
      this._waiters.shift()(str);
    } else {
      this._inQueue.push(str);
    }
    if (this.settings.echo) this.write(str);
  }
}
