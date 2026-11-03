export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubApiError extends Error {
  status: number;
  constructor(status: number, method: string, path: string, body: string) {
    super(`GitHub ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface ClientOptions {
  /** Called per request; the token never leaves the server process. */
  getToken: () => Promise<string> | string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string>;
  accept?: string;
  /** Statuses that are returned instead of thrown (e.g. 404 for "does not exist"). */
  allow?: number[];
}

/** Thin REST wrapper. Knows nothing about storage; GitHubBackend builds on it. */
export class GitHubClient {
  private opts: ClientOptions;
  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  async request(method: string, path: string, o: RequestOptions = {}): Promise<Response> {
    const url = new URL((this.opts.baseUrl ?? 'https://api.github.com') + path);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const f = this.opts.fetch ?? fetch;
    const res = await f(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${await this.opts.getToken()}`,
        Accept: o.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (!res.ok && !(o.allow ?? []).includes(res.status)) {
      throw new GitHubApiError(res.status, method, path, await res.text());
    }
    return res;
  }

  async json<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    return (await this.request(method, path, o)).json() as Promise<T>;
  }
}
