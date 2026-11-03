import { createHash } from 'node:crypto';

type Snapshot = Map<string, string>; // path -> blob sha
const sha1 = (...p: (string | Buffer)[]) => { const h = createHash('sha1'); p.forEach((x) => h.update(x)); return h.digest('hex'); };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** In-memory imitation of the handful of GitHub REST endpoints GitHubBackend uses. For tests only. */
export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Snapshot>();
  commits = new Map<string, { tree: string; parent: string | null; message: string }>();
  order: string[] = [];
  head: string | null = null;
  requests: { method: string; path: string; auth: string | null }[] = [];
  private owner: string;
  private repo: string;

  constructor(owner = 'me', repo = 'mycloud-01') {
    this.owner = owner;
    this.repo = repo;
  }

  private putBlob(data: Buffer): string {
    const sha = sha1(`blob ${data.length}\0`, data);
    this.blobs.set(sha, data);
    return sha;
  }
  private putTree(s: Snapshot): string {
    const sha = sha1(JSON.stringify([...s].sort()));
    this.trees.set(sha, s);
    return sha;
  }
  private putCommit(tree: string, parent: string | null, message: string): string {
    const sha = sha1(`commit ${tree} ${parent} ${message} ${this.order.length}`);
    this.commits.set(sha, { tree, parent, message });
    this.order.push(sha);
    return sha;
  }
  private resolve(ref: string | null): string | null {
    if (!ref) return this.head;
    if (ref === 'main') return this.head;
    return this.commits.has(ref) ? ref : null;
  }

  /** Bytes actually held by unique blobs, for assertions on "history is retained". */
  uniqueBlobBytes(): number {
    return [...this.blobs.values()].reduce((n, b) => n + b.length, 0);
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const prefix = `/repos/${this.owner}/${this.repo}`;
    this.requests.push({ method, path: u.pathname, auth: headers.get('authorization') });
    if (!u.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const p = u.pathname.slice(prefix.length);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '') return json(200, { size: Math.ceil(this.uniqueBlobBytes() / 1024), default_branch: 'main' });
    if (method === 'GET' && p === '/git/ref/heads/main') return this.head ? json(200, { object: { sha: this.head } }) : json(409, { message: 'Git Repository is empty.' });
    if (method === 'GET' && (m = /^\/git\/commits\/(\w+)$/.exec(p))) {
      const c = this.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = /^\/commits\/(\w+)$/.exec(p))) {
      return this.resolve(m[1]) ? json(200, { sha: m[1] }) : json(404, { message: 'No commit found' });
    }
    if (method === 'GET' && p === '/commits') {
      const n = this.order.length;
      return json(200, this.order.slice(-1).map((sha) => ({ sha })), n > 1 ? { link: `<https://api.github.com${prefix}/commits?per_page=1&page=${n}>; rel="last"` } : {});
    }
    if (method === 'GET' && (m = /^\/git\/trees\/(\w+)$/.exec(p))) {
      const t = this.trees.get(m[1]);
      if (!t) return json(404, { message: 'Not Found' });
      return json(200, { truncated: false, tree: [...t].map(([path, sha]) => ({ path, type: 'blob', sha, size: this.blobs.get(sha)!.length })) });
    }
    if (method === 'POST' && p === '/git/blobs') {
      if (body.encoding !== 'base64') return json(422, { message: 'expected base64' });
      return json(201, { sha: this.putBlob(Buffer.from(body.content, 'base64')) });
    }
    if (method === 'POST' && p === '/git/trees') {
      const base = this.trees.get(body.base_tree);
      if (!base) return json(422, { message: 'bad base_tree' });
      const next = new Map(base);
      for (const e of body.tree as { path: string; sha: string | null }[]) {
        if (e.sha === null) { if (!next.delete(e.path)) return json(422, { message: `no such path ${e.path}` }); }
        else next.set(e.path, e.sha);
      }
      return json(201, { sha: this.putTree(next) });
    }
    if (method === 'POST' && p === '/git/commits') {
      if (!this.trees.has(body.tree)) return json(422, { message: 'bad tree' });
      return json(201, { sha: this.putCommit(body.tree, body.parents[0] ?? null, body.message) });
    }
    if (method === 'PATCH' && p === '/git/refs/heads/main') {
      const c = this.commits.get(body.sha);
      if (!c || c.parent !== this.head) return json(422, { message: 'Update is not a fast forward' });
      this.head = body.sha;
      return json(200, { object: { sha: body.sha } });
    }
    if (method === 'GET' && (m = /^\/contents\/(.+)$/.exec(p))) {
      const at = this.resolve(u.searchParams.get('ref'));
      if (!at) return json(404, { message: 'No commit found for the ref' });
      const blob = this.trees.get(this.commits.get(at)!.tree)!.get(decodeURIComponent(m[1]).split('/').map(decodeURIComponent).join('/'));
      if (!blob) return json(404, { message: 'Not Found' });
      return new Response(new Uint8Array(this.blobs.get(blob)!), { status: 200 });
    }
    if (method === 'PUT' && (m = /^\/contents\/(.+)$/.exec(p))) {
      if (this.head) return json(422, { message: 'fake supports PUT only on an empty repo' });
      const tree = this.putTree(new Map([[m[1], this.putBlob(Buffer.from(body.content, 'base64'))]]));
      this.head = this.putCommit(tree, null, body.message);
      return json(201, { commit: { sha: this.head } });
    }
    return json(404, { message: `FakeGitHub: unhandled ${method} ${p}` });
  };
}
