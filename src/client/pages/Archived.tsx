import { useState } from 'react';
import { listFiles } from '../api/client.ts';
import { fmtBytes, shortSha } from '../api/format.ts';
import { RestorePanel } from '../components/RestorePanel.tsx';
import { ARCHIVE_WARNING } from '../components/FileTree.tsx';
import { Async, useAsync } from '../hooks.tsx';

export function Archived({ backend }: { backend: 'local' | 'github' }) {
  const state = useAsync(() => listFiles('archived'));
  const [restoring, setRestoring] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false); // list changed server-side; refresh after the panel is closed so the result stays visible
  const close = () => { setRestoring(null); if (dirty) { setDirty(false); state.reload(); } };
  return (
    <section>
      <h2>Archived</h2>
      <div className="warn">{ARCHIVE_WARNING}</div>
      <Async state={state}>{(files) => files.length === 0 ? <p>Nothing archived.</p> : (
        <div className="list">{files.map((f) => (
          <div className="card wide" key={f.virtualPath} data-testid="archived-card">
            <h3>{f.virtualPath}</h3>
            <dl>
              <dt>Original</dt><dd>{fmtBytes(f.originalSize)} (PARW {fmtBytes(f.storedSize)})</dd>
              <dt>Archived</dt><dd>Yes, {f.archivedAt ? new Date(f.archivedAt).toLocaleString() : ''}</dd>
              <dt>Repository</dt><dd>{f.repository}</dd>
              <dt>Historical commit</dt><dd><code title={f.archivedFromCommitSha ?? ''}>{shortSha(f.archivedFromCommitSha)}</code></dd>
              <dt>Current footprint</dt><dd>{fmtBytes(f.currentRepoFootprint)} (pointer only)</dd>
            </dl>
            {restoring === f.virtualPath
              ? <RestorePanel path={f.virtualPath} backend={backend} onClose={close} onFinished={() => setDirty(true)} />
              : <button onClick={() => setRestoring(f.virtualPath)}>Restore</button>}
          </div>))}</div>
      )}</Async>
    </section>
  );
}
