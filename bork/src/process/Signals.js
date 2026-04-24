/**
 * BORK Signal System
 * POSIX-lite signal delivery. Processes register handlers or use defaults.
 * Signals: SIGTERM, SIGKILL, SIGINT, SIGCHLD, SIGUSR1, SIGUSR2, SIGHUP, SIGPIPE
 */

export const SIGNALS = {
  SIGHUP:  1,   // hangup
  SIGINT:  2,   // interrupt (Ctrl+C)
  SIGQUIT: 3,   // quit
  SIGKILL: 9,   // kill (uncatchable)
  SIGTERM: 15,  // terminate (catchable)
  SIGCHLD: 17,  // child state changed
  SIGCONT: 18,  // continue
  SIGSTOP: 19,  // stop (uncatchable)
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,  // broken pipe
  SIGALRM: 14,  // alarm
};

export const SIG_DFL = 'DEFAULT';
export const SIG_IGN = 'IGNORE';

export class SignalManager {
  constructor() {
    // pid → Map<signum, handler|SIG_DFL|SIG_IGN>
    this._handlers = new Map();
    // pid → [pending signum]
    this._pending  = new Map();
    // pid → callback when signal delivered
    this._notifiers = new Map();
  }

  registerPid(pid) {
    this._handlers.set(pid, new Map());
    this._pending.set(pid, []);
  }

  freePid(pid) {
    this._handlers.delete(pid);
    this._pending.delete(pid);
    this._notifiers.delete(pid);
  }

  /** Set signal handler for a pid. handler = function(sig) | SIG_DFL | SIG_IGN */
  setHandler(pid, signame, handler) {
    const signum = typeof signame === 'string' ? (SIGNALS[signame] ?? parseInt(signame)) : signame;
    this._handlers.get(pid)?.set(signum, handler);
  }

  /** Deliver a signal to a pid. Returns action taken. */
  send(pid, signame) {
    const signum = typeof signame === 'string' ? (SIGNALS[signame] ?? parseInt(signame)) : signame;

    // SIGKILL and SIGSTOP are uncatchable
    if (signum === SIGNALS.SIGKILL) return 'kill';
    if (signum === SIGNALS.SIGSTOP) return 'stop';

    const handlers = this._handlers.get(pid);
    if (!handlers) return 'no-such-process';

    const handler = handlers.get(signum) ?? SIG_DFL;

    if (handler === SIG_IGN) return 'ignored';

    if (handler === SIG_DFL) {
      // Default actions
      if ([SIGNALS.SIGTERM, SIGNALS.SIGHUP, SIGNALS.SIGPIPE, SIGNALS.SIGALRM].includes(signum)) return 'terminate';
      if ([SIGNALS.SIGINT, SIGNALS.SIGQUIT].includes(signum)) return 'terminate';
      if (signum === SIGNALS.SIGCHLD) return 'ignored'; // default ignore
      if (signum === SIGNALS.SIGCONT) return 'continue';
      return 'terminate';
    }

    // Custom handler — call immediately (browser model has no preemption)
    // Also queue for processPending() so callers can use either model
    this._pending.get(pid)?.push(signum);
    const notifier = this._notifiers.get(pid);
    if (notifier) notifier(signum);
    // Direct delivery: call handler now
    try { handler(signum); } catch {}
    return 'queued';
  }

  /** Process pending signals for a pid. Calls handlers. */
  processPending(pid) {
    const pending = this._pending.get(pid);
    if (!pending?.length) return;
    const handlers = this._handlers.get(pid);
    while (pending.length) {
      const sig = pending.shift();
      const handler = handlers?.get(sig);
      if (typeof handler === 'function') {
        try { handler(sig); } catch {}
      }
    }
  }

  /** Register a callback to be notified when a signal arrives (for async waiting) */
  onSignal(pid, cb) { this._notifiers.set(pid, cb); }

  /** Get signal name from number */
  static name(signum) {
    return Object.entries(SIGNALS).find(([, n]) => n === signum)?.[0] ?? `SIG${signum}`;
  }

  /** Parse signal name or number */
  static parse(sigspec) {
    if (typeof sigspec === 'number') return sigspec;
    const asNum = parseInt(sigspec);
    if (!isNaN(asNum)) return asNum;
    const upper = sigspec.startsWith('SIG') ? sigspec : 'SIG' + sigspec.toUpperCase();
    return SIGNALS[upper] ?? SIGNALS[sigspec.toUpperCase()] ?? 15;
  }
}
