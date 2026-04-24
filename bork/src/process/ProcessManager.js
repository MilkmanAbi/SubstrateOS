import { SignalManager, SIGNALS } from './Signals.js';

export class ProcessManager {
  constructor() {
    this._procs    = new Map();
    this._nextPid  = 1;
    this._signals  = new SignalManager();
    this._startTime = Date.now();
  }

  spawn({ name='proc', cwd='/home/user', softMB=32, hardMB=128, parentPid=null, bg=false, env={}, stdin=null, stdout=null, stderr=null } = {}) {
    const pid = this._nextPid++;
    const proc = {
      pid, name, state:'RUNNING', cwd, parentPid, bg, softMB, hardMB,
      startTime: Date.now(), exitCode: null,
      fds: new Map([[0,stdin??'tty:stdin'],[1,stdout??'tty:stdout'],[2,stderr??'tty:stderr']]),
      nextFd: 3, env: {...env}, _waiters: [], _stopped: false,
    };
    this._procs.set(pid, proc);
    this._signals.registerPid(pid);
    return this._makeHandle(proc);
  }

  send(pid, signame) {
    const proc = this._procs.get(pid);
    if (!proc) return 'no-such-process';
    const action = this._signals.send(pid, signame);
    if (action === 'kill' || action === 'terminate') {
      const code = (signame === 'SIGKILL' || signame === 9) ? 137 : 1;
      this._doExit(proc, code);
    }
    if (action === 'stop') { proc._stopped = true; proc.state = 'SLEEPING'; }
    if (action === 'continue') { proc._stopped = false; proc.state = 'RUNNING'; }
    return action;
  }

  kill(pid, signal='SIGTERM') { return this.send(pid, signal); }

  exit(pid, code=0) { const p = this._procs.get(pid); if (p) this._doExit(p, code); }

  _doExit(proc, code) {
    if (proc.state === 'ZOMBIE' || proc.state === 'DEAD') return;
    proc.state = 'ZOMBIE'; proc.exitCode = code;
    for (const r of proc._waiters) r(code);
    proc._waiters = [];
    const stdout = proc.fds.get(1);
    if (stdout && typeof stdout.close === 'function') try { stdout.close(); } catch {}
    if (proc.parentPid) this._signals.send(proc.parentPid, SIGNALS.SIGCHLD);
  }

  wait(pid) {
    const proc = this._procs.get(pid);
    if (!proc) return Promise.resolve(0);
    if (proc.state === 'ZOMBIE' || proc.state === 'DEAD') return Promise.resolve(proc.exitCode ?? 0);
    return new Promise(r => proc._waiters.push(r));
  }

  reap(pid) {
    const p = this._procs.get(pid);
    if (p?.state === 'ZOMBIE') { p.state='DEAD'; this._procs.delete(pid); this._signals.freePid(pid); return p.exitCode; }
    return null;
  }

  openFd(pid, resource) {
    const p = this._procs.get(pid);
    if (!p) throw new Error(`ProcessManager: unknown PID ${pid}`);
    const fd = p.nextFd++; p.fds.set(fd, resource); return fd;
  }

  closeFd(pid, fd) {
    const p = this._procs.get(pid); const r = p?.fds.get(fd);
    if (r && typeof r.close === 'function') try { r.close(); } catch {}
    p?.fds.delete(fd);
  }

  getFd(pid, fd) { return this._procs.get(pid)?.fds.get(fd) ?? null; }
  dup2(pid, oldFd, newFd) { const p = this._procs.get(pid); if (!p) return; const r = p.fds.get(oldFd); if (r !== undefined) p.fds.set(newFd, r); }

  setCwd(pid, cwd) { const p = this._procs.get(pid); if (p) p.cwd = cwd; }
  getCwd(pid) { return this._procs.get(pid)?.cwd ?? '/home/user'; }

  setEnvProc(pid, key, value) { const p = this._procs.get(pid); if (p) p.env[key] = String(value); }
  getEnvProc(pid, key) { return this._procs.get(pid)?.env[key] ?? null; }
  getEnvAllProc(pid) { return {...(this._procs.get(pid)?.env ?? {})}; }

  get(pid) { return this._procs.get(pid) ?? null; }
  list() { return Array.from(this._procs.values()).map(p => this._snapshot(p)); }
  uptime() { return (Date.now() - this._startTime) / 1000; }

  setSignalHandler(pid, signame, handler) { this._signals.setHandler(pid, signame, handler); }
  onSignal(pid, cb) { this._signals.onSignal(pid, cb); }
  processPendingSignals(pid) { this._signals.processPending(pid); }

  _snapshot(p) {
    return { pid: p.pid, parentPid: p.parentPid, name: p.name, state: p.state,
             cwd: p.cwd, bg: p.bg, exitCode: p.exitCode,
             uptime: (Date.now() - p.startTime) / 1000, fds: p.fds.size, env: {...p.env} };
  }

  _makeHandle(proc) {
    const pm = this;
    return {
      pid: proc.pid,
      get name()  { return proc.name; },
      get state() { return proc.state; },
      get cwd()   { return proc.cwd; },
      kill:   (sig)  => pm.kill(proc.pid, sig),
      exit:   (code) => pm.exit(proc.pid, code),
      wait:   ()     => pm.wait(proc.pid),
      signal: (sig, h) => pm.setSignalHandler(proc.pid, sig, h),
      toJSON: ()     => pm._snapshot(proc),
    };
  }
}
