/**
 * BORK ProcFS v2
 * Synthetic /proc — reads computed live from kernel state.
 * Now exposes memory subsystem (velocity, dmu, profile, mode).
 */
export class ProcFS {
  constructor() {
    this._kernel    = null;
    this._rootInode = 100000;
    this._enc       = new TextEncoder();
    this.type       = 'backend';
  }

  attach(kernel) { this._kernel = kernel; }
  getRootInode() { return this._rootInode; }

  async readdir(inode) {
    if (inode === this._rootInode) {
      const base = [
        { name: 'meminfo',   inode: 100001, type: 'file' },
        { name: 'memprofile',inode: 100008, type: 'file' },
        { name: 'velocity',  inode: 100009, type: 'file' },
        { name: 'dmu',       inode: 100010, type: 'file' },
        { name: 'version',   inode: 100002, type: 'file' },
        { name: 'uptime',    inode: 100003, type: 'file' },
        { name: 'mounts',    inode: 100004, type: 'file' },
        { name: 'net',       inode: 100005, type: 'file' },
        { name: 'self',      inode: 100006, type: 'dir'  },
        { name: 'loadavg',   inode: 100007, type: 'file' },
      ];
      if (this._kernel) {
        for (const p of this._kernel.pm.list()) {
          base.push({ name: String(p.pid), inode: 200000 + p.pid, type: 'dir' });
        }
      }
      return base;
    }
    if (inode === 100006 || (inode >= 200000 && inode < 300000)) {
      const pid = inode === 100006 ? 1 : inode - 200000;
      return [
        { name: 'stat',    inode: 300000 + pid, type: 'file' },
        { name: 'status',  inode: 400000 + pid, type: 'file' },
        { name: 'environ', inode: 500000 + pid, type: 'file' },
        { name: 'fd',      inode: 600000 + pid, type: 'dir'  },
      ];
    }
    return [];
  }

  async read(inode) {
    const k = this._kernel;
    switch (inode) {
      case 100001: return this._enc.encode(this._meminfo(k));
      case 100002: return this._enc.encode(this._version(k));
      case 100003: return this._enc.encode(this._uptime(k));
      case 100004: return this._enc.encode(this._mounts(k));
      case 100005: return this._enc.encode(this._net(k));
      case 100007: return this._enc.encode(this._loadavg(k));
      case 100008: return this._enc.encode(this._memprofile(k));
      case 100009: return this._enc.encode(this._velocity(k));
      case 100010: return this._enc.encode(this._dmu(k));
    }
    if (inode >= 300000 && inode < 400000) return this._enc.encode(this._pidStat(k, inode - 300000));
    if (inode >= 400000 && inode < 500000) return this._enc.encode(this._pidStatus(k, inode - 400000));
    if (inode >= 500000 && inode < 600000) return this._enc.encode(this._pidEnviron(k, inode - 500000));
    return new Uint8Array(0);
  }

  async stat(inode) {
    const data = await this.read(inode);
    const isDir = inode === this._rootInode || inode === 100006 || (inode >= 200000 && inode < 300000);
    return { inode, type: isDir ? 'dir' : 'file', size: data.length, mode: 0o444, ctime: Date.now(), mtime: Date.now(), atime: Date.now() };
  }

  async write()  { throw new Error('ProcFS: read-only'); }
  async create() { throw new Error('ProcFS: read-only'); }
  async unlink() { throw new Error('ProcFS: read-only'); }
  async rename() { throw new Error('ProcFS: read-only'); }

  // ── Content generators ─────────────────────────────────────────────────────

  _meminfo(k) {
    if (!k) return 'unavailable\n';
    const m = k.mm.meminfo();
    const mb = n => (n == null || !isFinite(n)) ? 'unlimited' : (n / 1048576).toFixed(1) + ' MB';
    return [
      `MemMode:      ${m.mode}${m.pgs ? ' (PGS active — BORK will not save you)' : ''}`,
      `MemProfile:   ${m.profile ?? 'none (manual)'}`,
      `AdaptiveFactor: ${(m.adaptiveTighten * 100).toFixed(0)}%`,
      `MemTotal:     ${mb(m.total)}`,
      `MemUsed:      ${mb(m.used)}`,
      `MemFree:      ${mb(m.free)}`,
      `MemMaxPool:   ${mb(typeof m.maxPoolMB === 'number' ? m.maxPoolMB * 1048576 : Infinity)}`,
      `SlabSize:     ${m.slabSize} B`,
      `SlabTotal:    ${m.slabTotal}`,
      `SlabUsed:     ${m.slabUsed}`,
      `SlabFree:     ${m.slabFree}`,
      `Processes:    ${m.processes}`,
      '',
    ].join('\n');
  }

  _memprofile(k) {
    if (!k) return 'unavailable\n';
    const m = k.mm.meminfo();
    const v = m.velocity;
    return [
      `Mode:         ${m.mode}`,
      `Profile:      ${m.profile ?? 'none'}`,
      `PGS:          ${m.pgs ? 'YES — BORK will not save you' : 'no'}`,
      `Adaptive:     ${(m.adaptiveTighten * 100).toFixed(0)}% of nominal limits`,
      '',
      v ? `VelocityActive: ${v.active}` : '',
      v ? `VelocityLimit:  ${v.maxMBps} MB/s` : '',
      v ? `VelocityNow:    ${v.currentMBps} MB/s` : '',
      v ? `VelocityPeak:   ${v.peakMBps} MB/s` : '',
      v ? `VelocityBreached: ${v.breached}` : '',
      v ? `VelocityThrottled:${v.throttled}` : '',
      v ? `VelocityBreaches: ${v.breachCount}` : '',
      '',
    ].filter(Boolean).join('\n');
  }

  _velocity(k) {
    if (!k?.mm?.velocity) return 'MemoryVelocity: inactive\n';
    const v = k.mm.velocity.stats();
    if (!v.active) return 'MemoryVelocity: inactive (manual mode or PGS)\n';
    return Object.entries(v).map(([key, val]) => `${key.padEnd(20)} ${val}`).join('\n') + '\n';
  }

  _dmu(k) {
    if (!k?.mm?.dmu) return 'DMU: not initialised\n';
    const d = k.mm.dmu.stats();
    if (!d.active) return `DMU: inactive (${k.mm.meminfo().pgs ? 'PGS active — logging only' : 'manual mode'})\n`;
    return [
      `active:              ${d.active}`,
      `hot objects:         ${d.hot}`,
      `warm objects:        ${d.warm}`,
      `cold (swapped):      ${d.cold}`,
      `swap outs:           ${d.swapOuts}`,
      `swap ins:            ${d.swapIns}`,
      `evictions:           ${d.evictions}`,
      `drops:               ${d.drops}`,
      `savings:             ${d.savingsMB} MB`,
      `swap index entries:  ${d.swapIndexEntries}`,
      '',
    ].join('\n');
  }

  _version(k) {
    const v = k?.version ?? '2.0.0';
    return `BORK v${v} SubstrateOS browser-native x86_64 (JavaScript runtime)\n`;
  }

  _uptime(k) {
    const secs = k ? (Date.now() - k.startTime) / 1000 : 0;
    const load  = '0.00 0.00 0.00';
    return `${secs.toFixed(2)} ${(secs * 0.95).toFixed(2)}\n`;
  }

  _loadavg(k) {
    // Fake but plausible load average based on process count
    const procs = k?.pm?.list().length ?? 0;
    const load  = (procs * 0.08).toFixed(2);
    return `${load} ${(procs * 0.05).toFixed(2)} ${(procs * 0.03).toFixed(2)} ${procs}/64 1\n`;
  }

  _mounts(k) {
    if (!k?.vfs) return '';
    return k.vfs.mounts().map(m => `${m.fstype} on ${m.target} type ${m.fstype} (rw)`).join('\n') + '\n';
  }

  _net(k) {
    const enabled = k?._cfg?.networkEnabled ?? true;
    return `Inter-|   Receive                                                |  Transmit\n` +
           `face |bytes    packets errs drop ...| bytes    packets errs drop\n` +
           (enabled ? `  net:   0       0      0    0          0        0      0    0\n` : `  (disabled)\n`);
  }

  _pidStat(k, pid) {
    const p = k?.pm?.get(pid);
    if (!p) return '';
    const state = p.state === 'RUNNING' ? 'R' : p.state === 'SLEEPING' ? 'S' : p.state === 'ZOMBIE' ? 'Z' : 'D';
    const vsz = k?.mm?.pidUsage(pid) ?? 0;
    return `${p.pid} (${p.name}) ${state} ${p.parentPid ?? 0} ${p.pid} ${p.pid} 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 0 ${vsz} ${Math.floor(vsz/4096)}\n`;
  }

  _pidStatus(k, pid) {
    const p = k?.pm?.get(pid);
    if (!p) return '';
    const usedKB = Math.floor((k?.mm?.pidUsage(pid) ?? 0) / 1024);
    return [
      `Name:\t${p.name}`,
      `State:\t${p.state}`,
      `Pid:\t${p.pid}`,
      `PPid:\t${p.parentPid ?? 0}`,
      `Cwd:\t${p.cwd}`,
      `VmRSS:\t${usedKB} kB`,
      `VmSize:\t${usedKB} kB`,
      `Threads:\t1`,
      '',
    ].join('\n');
  }

  _pidEnviron(k, pid) {
    const env = k?.mm?.getEnvAll(pid) ?? {};
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
  }
}
