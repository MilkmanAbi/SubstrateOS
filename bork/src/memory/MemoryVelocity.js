/**
 * BORK MemoryVelocity
 *
 * Tracks memory allocation velocity (MB/sec) over a rolling window.
 * If velocity exceeds profile thresholds it:
 *   1. Emits a warning event so the dev console knows
 *   2. Calls back to DMU asking it to start evicting
 *   3. Optionally throttles future malloc calls (profile.velocity.throttleOnBreach)
 *
 * THIS MODULE ONLY RUNS WHEN A NAMED PROFILE IS ACTIVE.
 * If the dev called mm.setLimit() directly or is running PGS,
 * MemoryVelocity is instantiated but completely inert — it will
 * record() calls but never act on them.
 *
 * Why velocity matters:
 *   A tab allocating 200MB total is fine.
 *   A tab allocating 200MB in 400ms is probably a loop bug or a leak,
 *   and catching it before the browser OOM-kills the tab is valuable.
 *   That's all this does. It's not deep. It's a rate-of-change alarm.
 */

export class MemoryVelocity {
  /**
   * @param {object} velocityCfg  - from profile.velocity
   * @param {boolean} active      - false = inert (manual setLimit or PGS mode)
   */
  constructor(velocityCfg = {}, active = true) {
    this._active = active;

    // Rolling window: array of { ts, deltaBytes }
    this._window    = [];
    this._windowMs  = velocityCfg.windowMs   ?? 3000;
    this._maxBps    = (velocityCfg.maxMBperSec ?? 24) * 1024 * 1024;
    this._burst     = velocityCfg.burstTolerance ?? 1.8;
    this._throttle  = velocityCfg.throttleOnBreach ?? false;

    this._breached  = false;     // currently over threshold?
    this._throttled = false;     // actively blocking mallocs?
    this._throttleUntil = 0;

    // External callbacks
    this._onBreach  = null;      // (velocityBps, threshBps) → void
    this._onRecover = null;      // () → void
    this._onDmu     = null;      // DMU notifier: () → void (called when eviction needed)

    // Stats
    this._peakBps   = 0;
    this._totalBytes = 0;
    this._breachCount = 0;
  }

  // ── Wire-up ────────────────────────────────────────────────────────────────

  onBreach(cb)  { this._onBreach  = cb; }
  onRecover(cb) { this._onRecover = cb; }
  onDmu(cb)     { this._onDmu     = cb; }

  // ── Record an allocation ───────────────────────────────────────────────────

  /**
   * Called by MemoryManager every time malloc() completes.
   * @param {number} bytes  - bytes just allocated
   * @returns {boolean}     - true = allocation is fine, false = throttle active
   */
  record(bytes) {
    if (!this._active) return true;

    const now = Date.now();
    this._window.push({ ts: now, bytes });
    this._totalBytes += bytes;

    // Trim window
    const cutoff = now - this._windowMs;
    while (this._window.length && this._window[0].ts < cutoff) this._window.shift();

    const currentVelocity = this._windowVelocity();
    if (currentVelocity > this._peakBps) this._peakBps = currentVelocity;

    const threshold = this._maxBps * this._burst;

    // Breach detection
    if (currentVelocity > threshold && !this._breached) {
      this._breached = true;
      this._breachCount++;
      this._onBreach?.(currentVelocity, threshold);
      this._onDmu?.();   // tell DMU to start sweeping

      if (this._throttle) {
        this._throttled = true;
        this._throttleUntil = now + Math.min(this._windowMs * 0.5, 1500);
      }
    }

    // Recovery
    if (currentVelocity < this._maxBps * 0.7 && this._breached) {
      this._breached  = false;
      this._throttled = false;
      this._onRecover?.();
    }

    // Check throttle expiry
    if (this._throttled && Date.now() > this._throttleUntil) {
      this._throttled = false;
    }

    return !this._throttled;
  }

  // ── Release: track frees too (velocity can be negative = good) ────────────

  recordFree(bytes) {
    if (!this._active) return;
    // Just note it — we don't count frees against velocity since they're good
    // But do unthrottle faster if frees are happening
    if (this._throttled && bytes > 0) {
      this._throttleUntil = Math.max(this._throttleUntil - 200, Date.now());
    }
  }

  // ── Throttle check (called by MemoryManager before allowing malloc) ────────

  isThrottled() {
    if (!this._active || !this._throttle) return false;
    if (this._throttled && Date.now() > this._throttleUntil) {
      this._throttled = false;
    }
    return this._throttled;
  }

  /**
   * Async yield point for throttled allocations.
   * If throttle is active, waits until it expires.
   */
  async waitIfThrottled() {
    if (!this.isThrottled()) return;
    const remaining = this._throttleUntil - Date.now();
    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  currentVelocityMBps() {
    return this._windowVelocity() / (1024 * 1024);
  }

  stats() {
    return {
      active:          this._active,
      currentMBps:     this.currentVelocityMBps().toFixed(2),
      peakMBps:        (this._peakBps / (1024 * 1024)).toFixed(2),
      maxMBps:         (this._maxBps / (1024 * 1024)).toFixed(0),
      breached:        this._breached,
      throttled:       this._throttled,
      breachCount:     this._breachCount,
      windowSamples:   this._window.length,
      totalBytesTracked: this._totalBytes,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _windowVelocity() {
    if (this._window.length < 2) return 0;
    const total = this._window.reduce((s, e) => s + e.bytes, 0);
    const spanMs = this._window[this._window.length - 1].ts - this._window[0].ts;
    // Minimum 1ms span to avoid division by zero in fast synchronous loops.
    // If 5+ items arrived within 1ms, treat it as a 1ms burst — real velocity
    // can only be measured with time, so use the actual window duration but
    // floor it at 1ms. This means a burst of N bytes in <1ms is treated as
    // N bytes/ms = N*1000 bytes/sec, which is the correct worst-case reading.
    const span = Math.max(spanMs, 1) / 1000;
    return total / span;
  }
}
