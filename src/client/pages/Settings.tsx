import { fmtBytes } from '../api/format.ts';
import type { Settings as S } from '../api/types.ts';
import { Tag } from '../hooks.tsx';

export function SettingsPage({ settings }: { settings: S }) {
  const gh = settings.github;
  return (
    <section>
      <h2>Settings</h2>
      <p className="muted">Read-only. Configure through environment variables (see .env.example) and restart the server.</p>
      <dl className="kv">
        <dt>Storage backend</dt><dd>{settings.backend === 'local' ? 'Local (simulated repositories)' : <>GitHub <Tag kind="ok">Connected backend</Tag></>} <code>STORAGE_BACKEND</code></dd>
        <dt>Repository target size</dt><dd>{fmtBytes(settings.targetRepositorySize)} <code>TARGET_REPOSITORY_SIZE</code></dd>
        <dt>Maximum repositories</dt><dd>{settings.maxRepositories} <code>MAX_REPOSITORIES</code></dd>
        <dt>Maximum encoded file size</dt><dd>{fmtBytes(settings.maxFileSize)} <code>MAX_GITHUB_FILE_SIZE</code> (larger files are refused; chunking is not integrated)</dd>
        <dt>PARW compression</dt><dd>{settings.parwCompression.algorithm} level {settings.parwCompression.level}; {settings.parwCompression.fallback}</dd>
        <dt>Experiment limits</dt><dd>≤ {settings.experimentLimits.maxFiles} files, each ≤ {settings.experimentLimits.maxSizeMiB} MiB</dd>
        <dt>GitHub connection</dt>
        <dd>
          {settings.backend === 'local' ? 'Not used in local mode.' : gh.connected ? `Connected as ${gh.login}` : 'Not connected'}
          {settings.backend === 'github' && !gh.connected && (gh.oauthConfigured ? <> <a className="btn" href="/api/auth/github/login">Connect GitHub</a></> : <span className="error"> OAuth is not configured (set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL).</span>)}
        </dd>
        <dt>OAuth scope requested</dt><dd><code>{gh.scope}</code> (the token stays on the server; the browser never sees it)</dd>
      </dl>
    </section>
  );
}
