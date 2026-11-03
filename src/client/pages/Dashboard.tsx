import { getDashboard } from '../api/client.ts';
import { fmtBytes, fmtSavings } from '../api/format.ts';
import type { Dashboard as DashboardData } from '../api/types.ts';
import { Async, Tag, useAsync } from '../hooks.tsx';

export function Dashboard({ backend }: { backend: 'local' | 'github' }) {
  const state = useAsync(getDashboard);
  return <section><h2>Dashboard</h2><Async state={state}>{(d) => <DashboardView d={d} backend={backend} />}</Async><p><a className="btn" href="#/upload">Upload files</a></p></section>;
}

function DashboardView({ d, backend }: { d: DashboardData; backend: 'local' | 'github' }) {
  const measured = d.historical.measuredObjectBytes;
  return (
    <>
      <div className="cards">
        <Card title="Current tree size" value={fmtBytes(d.tree.currentRepoBytes)} note="bytes in the current Git trees (PARW files + pointers)" />
        <Card title="Logical size (active files)" value={fmtBytes(d.tree.logicalBytes)} note="original, uncompressed bytes of active files" />
        <Card title="Historical Git data" value={fmtBytes(measured ?? d.historical.inferredRetainedBytes)}
          tag={measured !== null ? <Tag kind="measured" title="Counted by the storage backend">{backend === 'local' ? 'measured (local simulation)' : 'measured'}</Tag> : <Tag kind="inferred" title="Not reported by the backend; summed from what this app pushed">inferred, NOT measured</Tag>}
          note="data retained in Git history, including archived originals" />
        <Card title="Active files" value={String(d.tree.files)} />
        <Card title="Archived files" value={String(d.historical.archivedFiles)} note={`${fmtBytes(d.historical.archivedOriginalBytes)} of originals`} />
        <Card title="Repositories" value={`${d.repositories.length} / ${d.maxRepositories}`} note={`target ${fmtBytes(d.targetRepositorySize)} each`} />
        <Card title="Compression savings" value={fmtSavings(d.compression.ratio)} note={`${fmtBytes(d.compression.originalBytes)} → ${fmtBytes(d.compression.parwBytes)}`} />
        <Card title="Estimated repository size" value={fmtBytes(d.historical.estimatedRepoBytes)} tag={<Tag kind="estimate">estimate</Tag>} note={backend === 'github' ? 'GitHub-reported repository size (KB-rounded, can lag)' : 'local simulation'} />
      </div>
      <div className="warn">{d.notes[d.notes.length - 1]}</div>
      <h3>Repositories</h3>
      {d.repositories.length === 0 ? <p className="muted">No repositories yet. One is created on first upload.</p> : (
        <table>
          <thead><tr><th>Repository</th><th>Current tree</th><th>Historical footprint <Tag kind="estimate">estimate</Tag></th><th>Files</th><th>Status</th></tr></thead>
          <tbody>{d.repositories.map((r) => (
            <tr key={r.repoId}>
              <td>{r.owner}/{r.repository}</td>
              <td className="num">{fmtBytes(r.usage?.currentTreeBytes ?? r.approximateCurrentSize)}</td>
              <td className="num">{fmtBytes(r.approximateHistoricalSize)} <span className="muted">of {fmtBytes(r.targetSize)} target</span></td>
              <td className="num">{r.files} ({r.archivedFiles} archived)</td>
              <td>{r.status}</td>
            </tr>))}</tbody>
        </table>
      )}
      <p className="muted">“Historical footprint” is this app’s accounting estimate (every PARW file and pointer it committed, since Git history does not shrink). It is not a measurement of Git’s on-disk size.</p>
    </>
  );
}

function Card({ title, value, note, tag }: { title: string; value: string; note?: string; tag?: React.ReactNode }) {
  return <div className="card"><div className="card-title">{title} {tag}</div><div className="card-value">{value}</div>{note && <div className="muted">{note}</div>}</div>;
}
