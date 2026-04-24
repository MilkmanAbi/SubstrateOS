/**
 * BORK MemoryManager v3
 *
 * Public API:
 *   mm.profile(name)                   — apply named profile (mobile/desktop/aggressive)
 *   mm.setLimit(maxMB)                 — manual override. no safety guarantees.
 *   mm.setPGS()                        — --platform-guaranteed-stability. BORK steps back.
 *   mm.malloc(pid, size)               — allocate
 *   mm.free(pid, ptr)                  — free
 *   mm.meminfo()                       — system-wide stats
 *   mm.dmu / mm.velocity               — subsystem accessors
 *
 * Three operating modes:
 *   PROFILE   — named preset active. MemoryVelocity + DMU both fully armed.
 *   MANUAL    — dev called setLimit(). MemoryVelocity inert. DMU logs only.
 *   PGS       — platform-guaranteed-stability. BORK does nothing. You're on your own.
 *
 * Adaptive fallback:
 *   Runs continuously in PROFILE and MANUAL modes (not PGS).
 *   If navigator.deviceMemory or performance.memory signals real pressure,
 *   BORK quietly tightens per-process limits by up to 25%.
 *   This is not a guarantee — it's a best-effort attempt to not crash your tab.
 *   It does NOT override PGS. It does NOT override hard setLimit() calls in MANUAL mode.
 *   It CAN override profile defaults, but only to make them tighter — never looser.
 */

import { PROFILES, PLATFORM_GUARANTEED_STABILITY } from './MemProfiles.js';
import { MemoryVelocity }         from './MemoryVelocity.js';
import { DynamicMemoryUnloader }  from './DynamicMemoryUnloader.js';

const MB = 1024 * 1024;

// Ceiling above which you MUST use PGS — BORK won't let you go higher by accident
const SAFETY_CEILING_MB = 2048;

export class MemoryManager {
  constructor({ poolMB = 256, maxPoolMB = 2048, slabSize = 4096 } = {}) {
    this._slabSize   = slabSize;
    this._slabTotal  = 0;
    this._free       = null;
    this._pool       = null;
    this._view       = null;

    this._poolBytes  = poolMB * MB;
    this._maxBytes   = maxPoolMB * MB;

    // Default mode: PROFILE with 'desktop' semantics
    this._mode       = 'profile';  // 'profile' | 'manual' | 'pgs'
    this._profileName = null;
    this._cfg        = null;

    // Per-process maps
    this._pidSlabs   = new Map();   // pid → Set<slabIdx>
    this._pidSoft    = new Map();   // pid → softBytes
    this._pidHard    = new Map();   // pid → hardBytes
    this._pidEnv     = new Map();   // pid → Map<k,v>
    this._allocMeta  = new Map();   // ptr → {pid, slabs, size}

    // JS-heap object registry
    this._objReg     = new Map();   // id → WeakRef
    this._objSeq     = 0;

    this._startTime  = Date.now();

    // Subsystems — created after profile is set
    this.velocity    = null;
    this.dmu         = null;

    // Adaptive fallback state
    this._adaptiveTighten = 1.0;   // multiplier applied to limits (≤1.0)
    this._adaptiveTimer   = null;

    // Initialise pool
    this._allocPool(poolMB);
  }

  // ── Profile & limits ──────────────────────────────────────────────────────

  /**
   * Apply a named profile.
   * Creates MemoryVelocity and DMU with matching config.
   * Can be called multiple times to switch profiles at runtime.
   */
  profile(name) {
    const cfg = PROFILES[name];
    if (!cfg) throw new Error(`MemoryManager: unknown profile '${name}'. Available: ${Object.keys(PROFILES).join(', ')}`);
    this._profileName = name;
    this._cfg         = cfg;
    this._mode        = 'profile';

    // Resize pool if profile asks for it
    const profileMax = cfg.maxPoolMB;
    if (profileMax > SAFETY_CEILING_MB && !this._pgs) {
      console.warn(`[MM] Profile '${name}' requests ${profileMax}MB but safety ceiling is ${SAFETY_CEILING_MB}MB. Call mm.setPGS() to lift this.`);
    }
    const clampedMax = this._pgs ? profileMax : Math.min(profileMax, SAFETY_CEILING_MB);
    this._maxBytes = clampedMax * MB;

    if (cfg.poolMB * MB > this._poolBytes) this._growPool(cfg.poolMB * MB - this._poolBytes);

    // Wire subsystems
    this.velocity = new MemoryVelocity(cfg.velocity, true);
    this.dmu      = new DynamicMemoryUnloader(this, cfg.eviction, cfg.swapDrivers, true);

    // Wire velocity → DMU
    this.velocity.onDmu(() => this.dmu?.notifyVelocityBreach());
    this.velocity.onBreach((vBps, thBps) => {
      console.warn(`[MemVelocity] Breach: ${(vBps/MB).toFixed(1)} MB/s > ${(thBps/MB).toFixed(1)} MB/s threshold`);
    });
    this.velocity.onRecover(() => {
      console.debug('[MemVelocity] Velocity normalised');
    });

    // Wire DMU drop event to loud console warning
    this.dmu.onDrop((key, bytes) => {
      console.error(`[DMU] !! DATA DROPPED: key=${key} size=${(bytes/1024).toFixed(0)}KB — swap space exhausted`);
    });

    if (cfg.swapEnabled) this.dmu.start();

    // Start adaptive fallback
    if (cfg.adaptiveFallback) this._startAdaptive();

    return this; // chainable
  }

  /**
   * Manual limit. You know what you're doing. MemoryVelocity becomes inert.
   * DMU runs in log-only mode. Adaptive fallback still runs unless you call setPGS().
   *
   * @param {number} maxMB   - maximum pool size in MB
   *
   * Above SAFETY_CEILING_MB requires setPGS() first. We'll remind you but not stop you.
   */
  setLimit(maxMB) {
    if (maxMB > SAFETY_CEILING_MB && !this._pgs) {
      console.warn(
        `[MM] setLimit(${maxMB}MB): above ${SAFETY_CEILING_MB}MB safety ceiling.\n` +
        `Call mm.setPGS() first if you have tested this on the target platform.\n` +
        `Without PGS, BORK will still try to protect the tab via adaptive fallback.`
      );
    }
    this._mode    = 'manual';
    this._maxBytes = maxMB * MB;
    this._cfg     = null;

    // Inert velocity (manual mode = dev owns this)
    this.velocity = new MemoryVelocity({}, false);

    // DMU in log-only mode
    if (this.dmu) this.dmu.stop();
    this.dmu = new DynamicMemoryUnloader(this, {}, [], false);

    // Adaptive fallback still runs in manual unless PGS
    if (!this._pgs) this._startAdaptive();

    return this;
  }

  /**
   * --platform-guaranteed-stability
   *
   * You have tested this. You know the numbers. BORK backs off completely.
   *
   * What this does:
   *   - Disables adaptive fallback
   *   - Disables MemoryVelocity actions (records but never acts)
   *   - Disables DMU eviction (logs what it would do but doesn't act)
   *   - Lifts the SAFETY_CEILING_MB cap on setLimit()
   *
   * What this does NOT do:
   *   - Does not prevent the browser from killing the tab
   *   - Does not give you more memory than the platform has
   *   - Does not make promises about SharedArrayBuffer availability
   *
   * This is "BORK will not save you anymore."
   * Not "you are guaranteed to be fine."
   */
  setPGS() {
    this._pgs  = true;
    this._mode = 'pgs';
    this._cfg  = PLATFORM_GUARANTEED_STABILITY;
    this._maxBytes = Infinity; // BORK imposes no ceiling

    this.velocity = new MemoryVelocity({}, false);    // inert

    if (this.dmu) this.dmu.stop();
    this.dmu = new DynamicMemoryUnloader(this, PLATFORM_GUARANTEED_STABILITY.eviction, [], false);

    // Kill adaptive fallback — explicitly
    this._stopAdaptive();

    console.info('[MM] PGS active. BORK will not save you anymore. Full allocation freedom enabled.');
    return this;
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────

  registerPid(pid, softMB = 32, hardMB = 128) {
    this._pidSlabs.set(pid, new Set());
    this._pidSoft.set(pid, this._applyAdaptive(softMB * MB));
    this._pidHard.set(pid, this._applyAdaptive(hardMB * MB));
    this._pidEnv.set(pid, new Map());
  }

  freePid(pid) {
    const slabs = this._pidSlabs.get(pid);
    if (slabs) for (const s of slabs) this._free[s] = 1;
    this._pidSlabs.delete(pid);
    this._pidSoft.delete(pid);
    this._pidHard.delete(pid);
    this._pidEnv.delete(pid);
    for (const [ptr, m] of this._allocMeta) if (m.pid === pid) this._allocMeta.delete(ptr);
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  async malloc(pid, size) {
    if (size <= 0) return 0;

    // Velocity throttle check (only active in profile mode)
    if (this.velocity?.isThrottled()) await this.velocity.waitIfThrottled();

    const pidSlabs = this._pidSlabs.get(pid);
    if (!pidSlabs) throw new Error(`MemoryManager: unknown PID ${pid}`);

    // Hard limit check
    const hard = this._pidHard.get(pid) ?? Infinity;
    const used = pidSlabs.size * this._slabSize;
    if (used + size > hard) throw new Error(
      `MemoryManager: PID ${pid} exceeded hard limit (${(hard/MB).toFixed(0)}MB). ` +
      `Current usage: ${(used/MB).toFixed(1)}MB`
    );

    const needed = Math.ceil(size / this._slabSize);
    const freeCount = this._free.reduce((n, v) => n + v, 0);
    if (freeCount < needed) this._growPool(needed * this._slabSize * 2);

    const start = this._findFreeRun(needed);
    if (start < 0) throw new Error('MemoryManager: pool exhausted. Increase poolMB in config.');

    for (let i = start; i < start + needed; i++) { this._free[i] = 0; pidSlabs.add(i); }
    const ptr = start * this._slabSize;
    this._allocMeta.set(ptr, { pid, slabs: needed, size });

    // Notify velocity tracker
    this.velocity?.record(size);

    // Soft limit warning
    const newUsed = pidSlabs.size * this._slabSize;
    if (this._pidSoft.has(pid) && newUsed > this._pidSoft.get(pid)) {
      console.warn(`[MM] PID ${pid}: soft limit exceeded (${(newUsed/MB).toFixed(1)}MB > ${(this._pidSoft.get(pid)/MB).toFixed(0)}MB)`);
    }

    return ptr;
  }

  // Synchronous malloc for hot paths — skips throttle and async machinery
  // Only use this if you're sure you're not in profile mode or velocity is fine
  mallocSync(pid, size) {
    if (size <= 0) return 0;
    const pidSlabs = this._pidSlabs.get(pid);
    if (!pidSlabs) throw new Error(`MemoryManager: unknown PID ${pid}`);
    const hard = this._pidHard.get(pid) ?? Infinity;
    if (pidSlabs.size * this._slabSize + size > hard) throw new Error(`PID ${pid}: hard limit`);
    const needed = Math.ceil(size / this._slabSize);
    if (this._free.reduce((n, v) => n + v, 0) < needed) this._growPool(needed * this._slabSize * 2);
    const start = this._findFreeRun(needed);
    if (start < 0) throw new Error('MemoryManager: pool exhausted');
    for (let i = start; i < start + needed; i++) { this._free[i] = 0; pidSlabs.add(i); }
    const ptr = start * this._slabSize;
    this._allocMeta.set(ptr, { pid, slabs: needed, size });
    this.velocity?.record(size);
    return ptr;
  }

  free(pid, ptr) {
    const meta = this._allocMeta.get(ptr);
    if (!meta) return;
    const pidSlabs = this._pidSlabs.get(pid);
    const start = Math.floor(ptr / this._slabSize);
    for (let i = start; i < start + meta.slabs; i++) { this._free[i] = 1; pidSlabs?.delete(i); }
    this._allocMeta.delete(ptr);
    this.velocity?.recordFree(meta.size);
  }

  write(ptr, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this._view.set(bytes, ptr);
    return ptr;
  }

  read(ptr, length)  { return this._view.slice(ptr, ptr + length); }
  view(ptr, length)  { return new Uint8Array(this._pool, ptr, length); }

  // ── JS-heap object registry ───────────────────────────────────────────────

  registerObject(obj) { const id = ++this._objSeq; this._objReg.set(id, new WeakRef(obj)); return id; }
  getObject(id) { const r = this._objReg.get(id); if (!r) return null; const o = r.deref(); if (!o) { this._objReg.delete(id); return null; } return o; }

  // ── Environment variables ─────────────────────────────────────────────────

  setEnv(pid, key, value)  { this._pidEnv.get(pid)?.set(key, String(value)); }
  getEnv(pid, key)         { return this._pidEnv.get(pid)?.get(key) ?? null; }
  getEnvAll(pid)           { return Object.fromEntries(this._pidEnv.get(pid) ?? []); }
  copyEnv(parentPid, childPid) {
    const p = this._pidEnv.get(parentPid); const c = this._pidEnv.get(childPid);
    if (p && c) for (const [k, v] of p) c.set(k, v);
  }

  // ── Info ──────────────────────────────────────────────────────────────────

  meminfo() {
    let usedSlabs = 0;
    for (const s of this._pidSlabs.values()) usedSlabs += s.size;
    const used = usedSlabs * this._slabSize;
    return {
      total:          this._poolBytes,
      used,
      free:           this._poolBytes - used,
      maxPool:        this._maxBytes === Infinity ? 'unlimited (PGS)' : this._maxBytes,
      maxPoolMB:      this._maxBytes === Infinity ? Infinity : this._maxBytes / MB,
      slabSize:       this._slabSize,
      slabTotal:      this._slabTotal,
      slabUsed:       usedSlabs,
      slabFree:       this._slabTotal - usedSlabs,
      processes:      this._pidSlabs.size,
      mode:           this._mode,
      profile:        this._profileName,
      pgs:            this._pgs ?? false,
      adaptiveTighten:this._adaptiveTighten,
      velocity:       this.velocity?.stats() ?? null,
      dmu:            this.dmu?.stats() ?? null,
    };
  }

  pidUsage(pid) { return (this._pidSlabs.get(pid)?.size ?? 0) * this._slabSize; }
  isSoftWarning(pid) { return this.pidUsage(pid) > (this._pidSoft.get(pid) ?? Infinity); }
  isHardViolation(pid) { return this.pidUsage(pid) > (this._pidHard.get(pid) ?? Infinity); }

  // ── Adaptive fallback ─────────────────────────────────────────────────────

  _startAdaptive() {
    this._stopAdaptive();
    this._adaptiveTimer = setInterval(() => this._adaptiveTick(), 5000);
  }

  _stopAdaptive() {
    if (this._adaptiveTimer) { clearInterval(this._adaptiveTimer); this._adaptiveTimer = null; }
  }

  _adaptiveTick() {
    if (this._pgs) return; // explicit no-op in PGS

    let pressure = 0;

    // navigator.deviceMemory: device RAM in GB
    if (typeof navigator?.deviceMemory !== 'undefined') {
      const deviceGB = navigator.deviceMemory;
      if (deviceGB <= 2) pressure = Math.max(pressure, 0.3);
      else if (deviceGB <= 4) pressure = Math.max(pressure, 0.1);
    }

    // performance.memory (Chrome only — deprecated but still works)
    try {
      const pm = performance?.memory;
      if (pm) {
        const usedRatio = pm.usedJSHeapSize / pm.jsHeapSizeLimit;
        if (usedRatio > 0.85) pressure = Math.max(pressure, 0.4);
        else if (usedRatio > 0.70) pressure = Math.max(pressure, 0.2);
        else if (usedRatio > 0.55) pressure = Math.max(pressure, 0.1);
      }
    } catch {}

    // Internal pool usage
    const info = this.meminfo();
    if (typeof info.used === 'number') {
      const poolRatio = info.used / this._poolBytes;
      if (poolRatio > 0.90) pressure = Math.max(pressure, 0.35);
      else if (poolRatio > 0.78) pressure = Math.max(pressure, 0.15);
    }

    if (pressure > 0) {
      // Tighten per-process limits by up to 25%
      const newTighten = Math.max(0.75, 1.0 - pressure * 0.25);
      if (newTighten < this._adaptiveTighten) {
        this._adaptiveTighten = newTighten;
        // Retroactively tighten all live process limits
        for (const [pid, soft] of this._pidSoft) {
          this._pidSoft.set(pid, soft * newTighten);
        }
        for (const [pid, hard] of this._pidHard) {
          this._pidHard.set(pid, hard * newTighten);
        }
        console.debug(`[MM/adaptive] Pressure=${pressure.toFixed(2)}, tightening limits to ${(newTighten*100).toFixed(0)}%`);
      }
    } else {
      // Slowly relax tighten factor back toward 1.0 if pressure subsides
      if (this._adaptiveTighten < 1.0) {
        this._adaptiveTighten = Math.min(1.0, this._adaptiveTighten + 0.05);
      }
    }
  }

  _applyAdaptive(bytes) {
    if (this._pgs) return bytes;
    return bytes * this._adaptiveTighten;
  }

  // ── Pool management ───────────────────────────────────────────────────────

  _allocPool(poolMB) {
    this._poolBytes  = poolMB * MB;
    this._pool       = new ArrayBuffer(this._poolBytes);
    this._view       = new Uint8Array(this._pool);
    this._slabTotal  = Math.floor(this._poolBytes / this._slabSize);
    this._free       = new Uint8Array(this._slabTotal).fill(1);
  }

  _growPool(neededBytes) {
    const ceiling = this._pgs ? Number.MAX_SAFE_INTEGER : this._maxBytes;
    const newSize  = Math.min(ceiling, this._poolBytes + Math.max(neededBytes, 64 * MB));
    if (newSize <= this._poolBytes) return;
    try {
      // ArrayBuffer.transfer = zero-copy in modern Chrome/Firefox
      if (typeof this._pool.transfer === 'function') {
        this._pool = this._pool.transfer(newSize);
      } else {
        const grown = new ArrayBuffer(newSize);
        new Uint8Array(grown).set(this._view);
        this._pool = grown;
      }
      this._view = new Uint8Array(this._pool);
      const newSlabTotal = Math.floor(newSize / this._slabSize);
      const newFree = new Uint8Array(newSlabTotal).fill(1);
      newFree.set(this._free);
      this._free      = newFree;
      this._slabTotal = newSlabTotal;
      this._poolBytes = newSize;
    } catch (e) {
      console.warn('[MM] Pool growth failed:', e.message);
    }
  }

  _findFreeRun(needed) {
    let start = -1, count = 0;
    for (let i = 0; i < this._slabTotal; i++) {
      if (this._free[i]) { if (count === 0) start = i; if (++count >= needed) return start; }
      else { start = -1; count = 0; }
    }
    return -1;
  }
}
