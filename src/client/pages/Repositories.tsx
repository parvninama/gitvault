import { Fragment, useState } from 'react';
import { getRepositories } from '../api/client.ts';
import { fmtBytes } from '../api/format.ts';
import type { Settings } from '../api/types.ts';
import { Async, Tag, useAsync } from '../hooks.tsx';

export function Repositories({ settings }: { settings: Settings }) {
  const state = useAsync(getRepositories);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section>
      <h2>Repositories</h2>
      <p className="muted">{settings.backend === 'local' ? 'Simulated repositories on local disk.' : 'Real GitHub repositories (experimental).'} The Files page hides these boundaries on purpose.</p>
      <Async state={state}>{(repos) => repos.length === 0 ? <p>No repositories yet.</p> : (
        <table>
          <thead><tr><th>Repository</th><th>Provider</th><th>Current tree</th><th>Historical <Tag kind="estimate">estimate</Tag></th><th>Target size</th><th>Files</th><th>Status</th></tr></thead>
          <tbody>{repos.map((r) => (
            <Fragment key={r.repoId}>
              <tr data-testid="repo-row">
                <td><button className="link" onClick={() => setOpen(open === r.repoId ? null : r.repoId)}>{open === r.repoId ? '▾' : '▸'} {r.owner}/{r.repository}</button></td>
                <td>{settings.backend === 'local' ? 'local simulation' : 'GitHub'}</td>
                <td className="num">{fmtBytes(r.usage?.currentTreeBytes ?? r.approximateCurrentSize)}</td>
                <td className="num">{fmtBytes(r.approximateHistoricalSize)}</td>
                <td className="num">{fmtBytes(r.targetSize)}</td>
                <td className="num">{r.files}</td>
                <td>{r.status}</td>
              </tr>
              {open === r.repoId && (
                <tr className="details"><td colSpan={7}>
                  {r.usage ? (
                    <dl>
                      <dt>Commits</dt><dd>{r.usage.commits}</dd>
                      <dt>Binary objects</dt><dd>{r.usage.binaryObjects ?? 'n/a (not exposed by the API)'}</dd>
                      <dt>Historical object bytes</dt><dd>{r.usage.historicalObjectBytes === null ? 'n/a (not exposed by the API)' : `${fmtBytes(r.usage.historicalObjectBytes)} (${r.usage.measurement})`}</dd>
                      <dt>Retained only in history</dt><dd>{fmtBytes(r.usage.retainedOnlyInHistoryBytes)}</dd>
                      <dt>Repository size estimate</dt><dd>{fmtBytes(r.usage.estimatedRepoBytes)}</dd>
                      <dt>Notes</dt><dd>{r.usage.notes.join(' ')}</dd>
                    </dl>) : <span className="muted">No usage data.</span>}
                </td></tr>)}
            </Fragment>))}</tbody>
        </table>
      )}</Async>
    </section>
  );
}
