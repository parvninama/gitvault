/** Single-user, in-memory token holder. The token lives only in this server process: never sent to the browser. */
export class TokenStore {
  private token: string | null = null;
  login: string | null = null;

  set(token: string, login: string): void {
    this.token = token;
    this.login = login;
  }
  clear(): void {
    this.token = null;
    this.login = null;
  }
  isConnected(): boolean {
    return this.token !== null;
  }
  require(): string {
    if (!this.token) throw new NotConnectedError();
    return this.token;
  }
}

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to GitHub');
    this.name = 'NotConnectedError';
  }
}
