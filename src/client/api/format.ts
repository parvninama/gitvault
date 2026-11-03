export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  let v = Math.abs(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 2)} ${units[i]}`;
}

/** ratio = 1 - stored/original. */
export function fmtSavings(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return 'n/a';
  const pct = Math.abs(ratio * 100).toFixed(1);
  if (Math.abs(ratio) < 0.0005) return 'no savings';
  return ratio > 0 ? `${pct}% smaller` : `${pct}% larger`;
}

export const shortSha = (s: string | null | undefined, n = 12) => (s ? s.slice(0, n) + '…' : '—');
