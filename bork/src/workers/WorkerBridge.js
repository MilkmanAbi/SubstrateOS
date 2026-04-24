/**
 * BORK WorkerBridge
 * Spawns real Web Worker threads for CPU-intensive tasks.
 * Workers get a bork.* API surface and communicate via postMessage IPC.
 * Real threads. Real isolation. Not "just JS in a wrapper."
 */
const BOOTSTRAP = `
const api={print:s=>self.postMessage({type:'stdout',data:s}),error:s=>self.postMessage({type:'stderr',data:s}),exit:c=>self.postMessage({type:'exit',code:c}),progress:(p,l)=>self.postMessage({type:'progress',pct:p,label:l}),_shm:null,initShm:b=>{api._shm=new Uint8Array(b)},shmWrite:(o,d)=>{const b=typeof d==='string'?new TextEncoder().encode(d):d;if(api._shm)api._shm.set(b,o)},shmRead:(o,n)=>api._shm?api._shm.slice(o,o+n):new Uint8Array(0),env:{}};
self.bork=api;
self.onmessage=async e=>{const{type,code,args,env,shm}=e.data;if(type!=='run')return;if(shm)api.initShm(shm);if(env)api.env=env;try{const fn=new Function('bork','args',code);const r=await fn(api,args??[]);self.postMessage({type:'exit',code:0,result:r})}catch(e){self.postMessage({type:'error',message:e.message});self.postMessage({type:'exit',code:1})}};
`;

export class WorkerBridge {
  constructor() {
    this._workers = new Map(); this._seq = 0;
    this._canSAB  = typeof SharedArrayBuffer !== 'undefined';
    this._blobUrl = null;
    try { const b = new Blob([BOOTSTRAP],{type:'application/javascript'}); this._blobUrl = URL.createObjectURL(b); } catch {}
  }

  get available() { return !!this._blobUrl && typeof Worker !== 'undefined'; }

  spawn(code, { args=[], env={}, shmBytes=0, onStdout=null, onProgress=null }={}) {
    if (!this.available) return Promise.reject(new Error('Workers unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      const w  = new Worker(this._blobUrl);
      const stdout = [];

      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'stdout')   { stdout.push(m.data); onStdout?.(m.data); }
        else if (m.type === 'stderr')   { onStdout?.('\x1b[31m' + m.data + '\x1b[0m'); }
        else if (m.type === 'progress') { onProgress?.(m.pct, m.label); }
        else if (m.type === 'error')    { onStdout?.('\x1b[31mworker: ' + m.message + '\x1b[0m\n'); }
        else if (m.type === 'exit')     { w.terminate(); this._workers.delete(id); resolve({ exitCode: m.code, result: m.result, stdout: stdout.join('') }); }
      };
      w.onerror = e => { w.terminate(); this._workers.delete(id); reject(new Error(e.message)); };
      this._workers.set(id, { w });

      let shm;
      if (shmBytes > 0 && this._canSAB) try { shm = new SharedArrayBuffer(shmBytes); } catch {}
      w.postMessage({ type:'run', code, args, env, shm }, shm ? [shm] : []);
    });
  }

  killAll() { for (const { w } of this._workers.values()) w.terminate(); this._workers.clear(); }
  get activeCount() { return this._workers.size; }
}
