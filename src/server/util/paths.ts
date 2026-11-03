/** Normalise a virtual/backend path: forward slashes, no leading slash, no "." / ".." / empty segments. */
export function normalizePath(p: string): string {
  const s = p.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = s.split('/');
  if (!s || parts.some((x) => x === '' || x === '.' || x === '..')) {
    throw new Error(`Invalid path: "${p}"`);
  }
  return parts.join('/');
}
