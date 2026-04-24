/**
 * BORK NetDevice
 * Fetch-based network bridge. Exposed at /dev/net and via bork.sys.fetch().
 * Allows shell commands like: wget https://example.com/file.txt > /home/user/file.txt
 */
export class NetDevice {
  constructor({ corsProxy = '' } = {}) {
    this._corsProxy = corsProxy;
    this._activeRequests = new Map(); // id → AbortController
    this._seq = 0;
    this.type = 'device';
  }

  /** Perform a fetch and return response data */
  async fetch(url, options = {}) {
    const id  = ++this._seq;
    const ctl = new AbortController();
    this._activeRequests.set(id, ctl);

    try {
      const targetUrl = this._corsProxy ? `${this._corsProxy}${encodeURIComponent(url)}` : url;
      const resp = await globalThis.fetch(targetUrl, {
        method:  options.method ?? 'GET',
        headers: options.headers ?? {},
        body:    options.body ?? undefined,
        signal:  ctl.signal,
      });

      const contentType = resp.headers.get('content-type') ?? '';
      const isText = contentType.includes('text') || contentType.includes('json') ||
                     contentType.includes('xml')  || contentType.includes('javascript');

      const data = await (isText ? resp.text() : resp.arrayBuffer());
      return {
        ok:          resp.ok,
        status:      resp.status,
        statusText:  resp.statusText,
        contentType,
        isText,
        data: isText ? new TextEncoder().encode(data) : new Uint8Array(data),
        text: isText ? data : null,
        size: isText ? data.length : data.byteLength,
        url:  resp.url,
      };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('NetDevice: request aborted');
      throw new Error(`NetDevice: fetch failed — ${e.message}`);
    } finally {
      this._activeRequests.delete(id);
    }
  }

  abort(id) {
    this._activeRequests.get(id)?.abort();
  }

  abortAll() {
    for (const ctl of this._activeRequests.values()) ctl.abort();
    this._activeRequests.clear();
  }

  /** Device interface (read = not meaningful, write = not meaningful) */
  async read(length) { return new Uint8Array(0); }
  async write(data)  { return 0; }
  ioctl(req, arg) {
    if (req === 'NET_FETCH')  return this.fetch(arg.url, arg);
    if (req === 'NET_ABORT')  return this.abort(arg);
    return null;
  }
}
