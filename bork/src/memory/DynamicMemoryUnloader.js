/**
 * BORK DynamicMemoryUnloader (DMU)
 *
 * Think of this as a mini GC that actually knows what's in BORK's memory model,
 * unlike V8's GC which just sees opaque ArrayBuffer references and does what it wants.
 *
 * DMU works WITH the JS GC, not against it:
 *   - It doesn't try to free things V8 doesn't want freed
 *   - It doesn't fight GC timing
 *   - It operates at the BORK abstraction level: it knows about processes, VFS
 *     cache, object registry entries, etc. V8 doesn't know any of that.
 *   - When DMU decides something can be evicted, it nulls out BORK-level references
 *     so V8 can collect them on its own schedule
 *
 * The three layers DMU manages:
 *
 *   HOT   → currently in ArrayBuffer pool (MemoryManager slabs)
 *            actively used, recently accessed, pinned by live process
 *
 *   WARM  → still in ArrayBuffer pool but LRU-eligible
 *            has not been accessed recently, no active process owns it
 *            candidate for swap-out to localStorage/sessionStorage
 *
 *   COLD  → evicted from pool, serialized to localStorage or sessionStorage
 *            reads cause a swap-in (decompression if large)
 *            can be fully purged if storage is also under pressure
 *
 * Swap backends:
 *   localStorage   → 5-10MB typical limit, survives tab close, slower
 *   sessionStorage → 5-10MB typical limit, cleared on tab close, faster
 *   The DMU tries localStorage first, falls back to sessionStorage,
 *   falls back to just evicting (drop the data) if both are full.
 *   It NEVER silently drops data without emitting a 'drop' event.
 *
 * Swappiness (0-1):
 *   0.0 = never evict unless absolutely forced (aggressive profile style)
 *   0.5 = balanced eviction (desktop profile)
 *   1.0 = evict aggressively at first sign of pressure (mobile profile)
 *
 * Running in PGS mode:
 *   DMU is instantiated but all _act() calls become no-ops.
 *   It still records everything so you can inspect what WOULD have happened.
 *   Good for debugging if you turn PGS on and the tab dies — you can see
 *   what DMU was tracking and decided not to act on.
 */

const SWAP_PREFIX = 'bork:dmu:swap:';
const SWAP_IDX    = 'bork:dmu:idx';
const MAX_SWAP_ITEM_BYTES = 512 * 1024;  // 512KB max per localStorage item

export class DynamicMemoryUnloader {
  /**
   * @param {MemoryManager} mm         - the kernel's memory manager
   * @param {object}        evictionCfg - from profile.eviction
   * @param {string[]}      swapDrivers - ['localStorage','sessionStorage'] or []
   * @param {boolean}       active      - false = PGS mode, log only
   */
  constructor(mm, evictionCfg = {}, swapDrivers = ['localStorage', 'sessionStorage'], active = true) {
    this._mm      = mm;
    this._active  = active;

    // Config
    this._aggressiveness = evictionCfg.aggressiveness  ?? 0.55;
    this._pressureThresh = evictionCfg.pressureThresh   ?? 0.68;
    this._killThresh     = evictionCfg.killThresh       ?? 0.90;
    this._intervalMs     = evictionCfg.checkIntervalMs  ?? 1500;

    this._swapDrivers    = swapDrivers;
    this._swapiness      = this._aggressiveness;  // direct mapping

    // Object registry: key → { pid, size, tier, lastAccess, swapKey }
    // tier: 'hot' | 'warm' | 'cold'
    this._registry = new Map();

    // Swap index: what's currently in localStorage/sessionStorage
    this._swapIndex = this._loadSwapIndex();

    // Stats
    this._swapOuts    = 0;
    this._swapIns     = 0;
    this._evictions   = 0;
    this._drops       = 0;
    this._savingsBytes = 0;

    // Event callbacks
    this._onEvict  = null;   // (key, bytes, reason) → void
    this._onSwapOut= null;   // (key, bytes, driver) → void
    this._onSwapIn = null;   // (key, bytes) → void
    this._onDrop   = null;   // (key, bytes) → void  -- data lost, be loud about this

    // Interval
    this._timer = null;
    this._velocityBreached = false;

    this._enc = new TextEncoder();
    this._dec = new TextDecoder();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sweep(), this._intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  onEvict(cb)   { this._onEvict   = cb; }
  onSwapOut(cb) { this._onSwapOut = cb; }
  onSwapIn(cb)  { this._onSwapIn  = cb; }
  onDrop(cb)    { this._onDrop    = cb; }

  // Called by MemoryVelocity when velocity breaches threshold
  notifyVelocityBreach() {
    this._velocityBreached = true;
    if (this._active) this._sweep(true);  // immediate sweep
  }

  // ── Object registration ───────────────────────────────────────────────────

  /**
   * Register a BORK-level object for DMU tracking.
   * This is how DMU knows what can potentially be evicted.
   *
   * @param {string} key        - unique identifier for this object
   * @param {number} pid        - owning process (0 = kernel/shared)
   * @param {number} bytes      - size estimate
   * @param {Function} serializer    - () → Uint8Array|string — called on swap-out
   * @param {Function} deserializer  - (data) → void — called on swap-in
   * @param {boolean} pinned    - if true, DMU will NEVER evict this
   */
  register(key, { pid = 0, bytes = 0, serializer, deserializer, pinned = false } = {}) {
    this._registry.set(key, {
      pid, bytes, pinned,
      tier: 'hot',
      lastAccess: Date.now(),
      accessCount: 0,
      serializer, deserializer,
      swapKey: null,
    });
  }

  /**
   * Mark a key as accessed — promotes it back to HOT, prevents imminent eviction.
   */
  touch(key) {
    const entry = this._registry.get(key);
    if (entry) { entry.lastAccess = Date.now(); entry.tier = 'hot'; entry.accessCount++; }
  }

  unregister(key) {
    const entry = this._registry.get(key);
    if (entry?.swapKey) this._deleteSwap(entry.swapKey);
    this._registry.delete(key);
  }

  /**
   * Request a swap-in for a COLD object. Returns true if successful.
   * Call this before accessing an object you registered if it might be COLD.
   */
  async ensureHot(key) {
    const entry = this._registry.get(key);
    if (!entry) return false;
    if (entry.tier !== 'cold') { entry.lastAccess = Date.now(); return true; }
    return this._swapIn(key, entry);
  }

  // ── Sweep logic ────────────────────────────────────────────────────────────

  async _sweep(urgent = false) {
    if (!this._active) {
      // PGS mode — log what we'd do but don't act
      this._logPgsSweep();
      return;
    }

    const info     = this._mm.meminfo();
    const usage    = info.used / info.total;
    const now      = Date.now();

    // Decide how aggressive to be this sweep
    const pressure = this._velocityBreached
      ? Math.min(usage + 0.15, 1.0)   // velocity breach: pretend we're 15% fuller
      : usage;

    this._velocityBreached = false;

    if (pressure < this._pressureThresh && !urgent) return; // nothing to do

    // Age objects: hot → warm if not accessed recently
    const warmThreshMs = this._ageLimitMs(pressure);
    let evictedBytes = 0;

    const candidates = [];
    for (const [key, entry] of this._registry) {
      if (entry.pinned || entry.tier === 'cold') continue;
      const age = now - entry.lastAccess;
      if (age > warmThreshMs) {
        if (entry.tier === 'hot') entry.tier = 'warm';
        if (entry.tier === 'warm' && age > warmThreshMs * 2) {
          candidates.push([key, entry, age]);
        }
      }
    }

    // Sort by least recently used, largest first
    candidates.sort((a, b) => {
      const ageDiff = b[2] - a[2];         // older = higher priority
      const sizeDiff = b[1].bytes - a[1].bytes;  // larger = higher priority
      return ageDiff || sizeDiff;
    });

    // How much do we need to free?
    const targetFree = pressure > this._killThresh
      ? info.total * 0.25    // critical: free 25%
      : info.total * (pressure - this._pressureThresh + 0.1);

    for (const [key, entry] of candidates) {
      if (evictedBytes >= targetFree) break;
      const freed = await this._evict(key, entry, pressure);
      evictedBytes += freed;
    }

    // Critical kill: if still over kill threshold, kill processes (least active first)
    if (usage > this._killThresh) {
      this._tryKillProcesses();
    }
  }

  async _evict(key, entry, pressure) {
    // Can we serialise it?
    if (entry.serializer && typeof entry.serializer === 'function') {
      const swapped = await this._swapOut(key, entry);
      if (swapped) {
        this._evictions++;
        this._savingsBytes += entry.bytes;
        this._onEvict?.(key, entry.bytes, 'swap');
        return entry.bytes;
      }
    }

    // Can't swap — drop if we're in extreme pressure
    if (pressure > this._killThresh * 0.95) {
      this._drops++;
      this._onDrop?.(key, entry.bytes);
      console.warn(`[DMU] DROPPED ${key} (${(entry.bytes/1024).toFixed(0)}KB) — no swap space, critical pressure`);
      this._registry.delete(key);
      return entry.bytes;
    }

    return 0;  // couldn't evict
  }

  // ── Swap I/O ──────────────────────────────────────────────────────────────

  async _swapOut(key, entry) {
    let data;
    try { data = entry.serializer(); }
    catch (e) { console.warn(`[DMU] serializer failed for ${key}:`, e); return false; }

    const bytes  = typeof data === 'string' ? this._enc.encode(data) : data;
    if (!bytes || bytes.length > MAX_SWAP_ITEM_BYTES) return false; // too large for storage

    const swapKey = SWAP_PREFIX + key.replace(/[^a-z0-9_-]/gi, '_');
    const payload = JSON.stringify({
      key, bytes: Array.from(bytes), ts: Date.now(), origBytes: entry.bytes,
    });

    for (const driver of this._swapDrivers) {
      const store = this._getStorage(driver);
      if (!store) continue;
      try {
        store.setItem(swapKey, payload);
        entry.tier    = 'cold';
        entry.swapKey = swapKey;
        this._swapIndex[key] = { driver, swapKey };
        this._saveSwapIndex();
        this._swapOuts++;
        this._onSwapOut?.(key, bytes.length, driver);
        return true;
      } catch {
        // storage full or quota exceeded — try next driver
        try { store.removeItem(swapKey); } catch {}
      }
    }

    return false;
  }

  async _swapIn(key, entry) {
    if (!entry.swapKey) return false;
    for (const driver of this._swapDrivers) {
      const store = this._getStorage(driver);
      if (!store) continue;
      try {
        const raw = store.getItem(entry.swapKey);
        if (!raw) continue;
        const { bytes } = JSON.parse(raw);
        const data = new Uint8Array(bytes);
        if (entry.deserializer) entry.deserializer(data);
        entry.tier       = 'hot';
        entry.lastAccess = Date.now();
        entry.swapKey    = null;
        delete this._swapIndex[key];
        this._saveSwapIndex();
        this._swapIns++;
        this._onSwapIn?.(key, data.length);
        return true;
      } catch {}
    }
    return false;
  }

  _deleteSwap(swapKey) {
    for (const driver of this._swapDrivers) {
      const store = this._getStorage(driver);
      try { store?.removeItem(swapKey); } catch {}
    }
  }

  _getStorage(driver) {
    try {
      if (driver === 'localStorage')   return globalThis.localStorage;
      if (driver === 'sessionStorage') return globalThis.sessionStorage;
    } catch {}
    return null;
  }

  _loadSwapIndex() {
    try {
      const raw = globalThis.localStorage?.getItem(SWAP_IDX);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  _saveSwapIndex() {
    try { globalThis.localStorage?.setItem(SWAP_IDX, JSON.stringify(this._swapIndex)); } catch {}
  }

  // ── Process killing ────────────────────────────────────────────────────────

  _tryKillProcesses() {
    const procs = this._mm._pidSlabs;
    if (!procs.size) return;
    // Find largest non-kernel process
    let maxPid = -1, maxMem = 0;
    for (const [pid, slabs] of procs) {
      if (pid <= 1) continue; // never kill kernel pid 1
      const mem = slabs.size * this._mm._slabSize;
      if (mem > maxMem) { maxMem = mem; maxPid = pid; }
    }
    if (maxPid > 0) {
      console.warn(`[DMU] Memory kill: sending SIGTERM to PID ${maxPid} (used ${(maxMem/1048576).toFixed(1)}MB)`);
      // We fire the event and let the kernel's ProcessManager handle it
      // DMU doesn't directly call pm.kill() — it emits and BORK wires the rest
      this._onEvict?.(String(maxPid), maxMem, 'process-kill');
    }
  }

  // ── Age calculation ────────────────────────────────────────────────────────

  _ageLimitMs(pressure) {
    // Under low pressure: only evict things not touched in 30+ seconds
    // Under high pressure: evict things not touched in 3 seconds
    const base = 30000;
    const min  = 3000;
    return Math.max(min, base * (1 - pressure * this._aggressiveness));
  }

  // ── PGS audit ─────────────────────────────────────────────────────────────

  _logPgsSweep() {
    const info  = this._mm.meminfo();
    const usage = info.used / info.total;
    if (usage > this._pressureThresh) {
      const candidates = Array.from(this._registry.entries())
        .filter(([, e]) => !e.pinned && e.tier !== 'cold')
        .length;
      console.debug(`[DMU/PGS] Would evict: usage=${(usage*100).toFixed(1)}%, candidates=${candidates} (not acting — PGS active)`);
    }
  }

  // ── Sweep metrics ──────────────────────────────────────────────────────────

  stats() {
    const hot  = Array.from(this._registry.values()).filter(e => e.tier === 'hot').length;
    const warm = Array.from(this._registry.values()).filter(e => e.tier === 'warm').length;
    const cold = Array.from(this._registry.values()).filter(e => e.tier === 'cold').length;
    const swappedBytes = Object.keys(this._swapIndex).length;
    return {
      active: this._active, hot, warm, cold,
      swapOuts: this._swapOuts, swapIns: this._swapIns,
      evictions: this._evictions, drops: this._drops,
      savingsMB: (this._savingsBytes / 1048576).toFixed(2),
      swapIndexEntries: swappedBytes,
    };
  }

  /**
   * Wipe all swap storage managed by this DMU instance.
   * Call on unmount or hard reset. Does not affect live pool.
   */
  clearSwap() {
    for (const driver of this._swapDrivers) {
      const store = this._getStorage(driver);
      if (!store) continue;
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k?.startsWith(SWAP_PREFIX)) keys.push(k);
      }
      for (const k of keys) { try { store.removeItem(k); } catch {} }
    }
    try { globalThis.localStorage?.removeItem(SWAP_IDX); } catch {}
    this._swapIndex = {};
  }
}
