import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../server/github/GitHubClient.ts';
import { GitHubStorageProvider } from '../server/github/GitHubStorageProvider.ts';
import { formatReport, runExperiment } from '../server/experiment/gitHistoryExperiment.ts';
import type { PayloadKind } from '../server/experiment/gitHistoryExperiment.ts';
import { LocalStorageProvider } from '../server/storage/LocalStorageProvider.ts';
import type { StorageProvider } from '../server/storage/types.ts';

const MB = 1024 * 1024;
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help')) {
  console.log(`usage: npm run experiment -- [--provider local|github] [--repo owner/name] [--branch main]
                           [--sizes 1,5,10,50] [--compressible] [--json report.json]
  local  (default) : offline git-like simulation in a temp dir; sizes default 1,5,10,50 (MiB)
  github           : needs GITHUB_TOKEN (CLI-only convenience; never put tokens in the browser) and --repo.
                     Sizes default to 1,5 so nothing large is pushed unless you ask. USE A THROWAWAY REPOSITORY:
                     every uploaded blob stays in its history permanently.`);
  process.exit(0);
}

const providerName = opt('provider') ?? 'local';
const sizes = (opt('sizes') ?? (providerName === 'github' ? '1,5' : '1,5,10,50')).split(',').map((s) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 50) throw new Error(`Invalid size "${s}" (allowed: 0 < MiB <= 50)`);
  return Math.round(n * MB);
});

let provider: StorageProvider;
let cleanup = () => {};
if (providerName === 'github') {
  const token = process.env.GITHUB_TOKEN;
  const repo = opt('repo');
  if (!token || !repo?.includes('/')) throw new Error('github provider needs GITHUB_TOKEN and --repo owner/name');
  const [owner, name] = repo.split('/');
  provider = new GitHubStorageProvider({ client: new GitHubClient({ getToken: () => token }), owner, repo: name, branch: opt('branch') });
} else if (providerName === 'local') {
  const dir = mkdtempSync(join(tmpdir(), 'gitvault-exp-'));
  provider = new LocalStorageProvider(dir);
  cleanup = () => rmSync(dir, { recursive: true, force: true });
} else {
  throw new Error(`Unknown provider "${providerName}"`);
}

try {
  const result = await runExperiment(provider, {
    sizes, kind: (args.includes('--compressible') ? 'compressible' : 'random') as PayloadKind,
    onProgress: (m) => console.error(m),
  });
  console.log(formatReport(result, { backend: providerName }));
  const jsonPath = opt('json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  if (result.files.some((f) => !f.verified)) process.exitCode = 1;
} finally {
  cleanup();
}
