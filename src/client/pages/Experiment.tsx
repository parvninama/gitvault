import { useState } from 'react';
import { runExperiment } from '../api/client.ts';
import { fmtBytes, fmtSavings } from '../api/format.ts';
import type { ExperimentResponse, Settings } from '../api/types.ts';
import { Tag } from '../hooks.tsx';
import { ARCHIVE_WARNING } from '../components/FileTree.tsx';

const SIZES = [1, 5, 10, 50];

export function Experiment({ settings }: { settings: Settings }) {
  const [sizes, setSizes] = useState<number[]>([1, 5]);
  const [kind, setKind] = useState<'random' | 'compressible'>('random');
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ExperimentResponse | null>(null);
  const gh = settings.backend === 'github';

  const run = async () => {
    setRunning(true); setError(null); setRes(null);
    try { setRes(await runExperiment({ sizesMiB: sizes, kind, confirmGitHub: gh ? confirm : undefined })); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  const toggle = (n: number) => setSizes((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n].sort((a, b) => a - b)));

  return (
    <section>
      <h2>Storage Experiment</h2>
      <div className="warn strong">{ARCHIVE_WARNING}</div>
      {gh
        ? <div className="error">Experimental GitHub backend: this experiment pushes REAL blobs into a real repository and they remain in its Git history permanently. Use a throwaway repository.</div>
        : <p className="muted">Local mode: runs in an isolated simulated repository. It validates the workflow and checksums only; it says nothing about GitHub’s real storage behaviour.</p>}
      <div className="row">
        {SIZES.map((n) => <label key={n}><input type="checkbox" checked={sizes.includes(n)} onChange={() => toggle(n)} /> {n} MiB</label>)}
        <label>Payload <select value={kind} onChange={(e) => setKind(e.target.value as 'random' | 'compressible')}><option value="random">random (incompressible)</option><option value="compressible">compressible</option></select></label>
      </div>
      {gh && <label><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand these blobs cannot be removed from Git history.</label>}
      <p className="muted">Limits: at most {settings.experimentLimits.maxFiles} files, each ≤ {settings.experimentLimits.maxSizeMiB} MiB. Nothing larger is generated.</p>
      <button onClick={run} disabled={running || sizes.length === 0 || sizes.length > settings.experimentLimits.maxFiles || (gh && !confirm)}>{running ? 'Running…' : 'Run experiment'}</button>
      {error && <div className="error" role="alert">{error}</div>}
      {res && <Results r={res} />}
    </section>
  );
}

function Results({ r }: { r: ExperimentResponse }) {
  const hist = (s: ExperimentResponse['result']['files'][number]['snapshots']['afterArchive']) => s.usage.historicalObjectBytes ?? s.usage.estimatedRepoBytes;
  return (
    <div data-testid="experiment-results">
      <h3>Results {r.sandboxed ? <Tag kind="muted">sandboxed simulation</Tag> : <Tag kind="warn">real backend</Tag>}</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr><th colSpan={3}>Test file</th><th colSpan={2} className="grp-tree">CURRENT TREE</th><th colSpan={3} className="grp-hist">HISTORICAL GIT DATA</th><th colSpan={2}>Verification</th></tr>
            <tr><th>Size</th><th>PARW</th><th>Compression</th><th className="grp-tree">Before archive</th><th className="grp-tree">After archive</th>
              <th className="grp-hist">Retained (after archive)</th><th className="grp-hist">Commits</th><th className="grp-hist">Binary objects</th><th>Restore</th><th>SHA-256</th></tr>
          </thead>
          <tbody>{r.result.files.map((f) => {
            const after = f.snapshots.afterArchive;
            const measured = after.usage.historicalObjectBytes !== null;
            return (
              <tr key={f.virtualPath} data-testid="experiment-row">
                <td>{fmtBytes(f.sizeBytes)}</td><td>{fmtBytes(f.parwSize)}</td><td>{fmtSavings(f.compressionRatio)}</td>
                <td className="grp-tree num">{fmtBytes(f.snapshots.afterUpload.usage.currentTreeBytes)}</td>
                <td className="grp-tree num">{fmtBytes(after.usage.currentTreeBytes)}</td>
                <td className="grp-hist num">{fmtBytes(hist(after))} <Tag kind={measured ? 'measured' : 'estimate'}>{measured ? 'measured (sim)' : 'estimate'}</Tag></td>
                <td className="grp-hist num">{after.usage.commits}</td>
                <td className="grp-hist num">{after.usage.binaryObjects ?? 'n/a'}</td>
                <td>{f.error ? <span className="fail">✗ {f.error}</span> : f.verified ? '✓ restored from history' : '✗ failed'}</td>
                <td>{f.verified ? <>✓ identical <code>{f.originalSha256.slice(0, 12)}…</code></> : '✗'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <p className="muted">Tree and history columns are cumulative across the test files in the same repository. Compare “Before” and “After”: the current tree drops by roughly the PARW size, while retained historical data does not drop.</p>
      <details><summary>Full text report</summary><pre>{r.report}</pre></details>
    </div>
  );
}
