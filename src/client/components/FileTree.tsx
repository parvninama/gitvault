import { useState } from 'react';
import { archiveFile, downloadUrl } from '../api/client.ts';
import { fmtBytes, fmtSavings, shortSha } from '../api/format.ts';
import type { FileView, TreeNode } from '../api/types.ts';
import { Tag } from '../hooks.tsx';
import { RestorePanel } from './RestorePanel.tsx';

export const ARCHIVE_WARNING = 'Archiving removes the file from the current tree but does not necessarily remove the historical Git object.';

function FileRow({ f, backend, onChanged }: { f: FileView; backend: 'local' | 'github'; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const archive = async () => {
    if (!window.confirm(`Archive ${f.virtualPath}?\n\n${ARCHIVE_WARNING}\n\nThe file stays restorable from Git history.`)) return;
    setBusy(true); setErr(null);
    try { await archiveFile(f.virtualPath); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <tr data-testid="file-row" data-path={f.virtualPath}>
        <td><button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'} {f.name}</button></td>
        <td className="num">{fmtBytes(f.originalSize)}</td>
        <td className="num">{fmtBytes(f.storedSize)}</td>
        <td>{fmtSavings(f.compressionRatio)}</td>
        <td>{f.status === 'archived' ? <Tag kind="warn">Archived</Tag> : <Tag kind="ok">Active</Tag>}</td>
        <td className="actions">
          {f.status === 'active' && <><a className="btn" href={downloadUrl(f.virtualPath)} download={f.name}>Download</a> <button onClick={archive} disabled={busy}>Archive</button></>}
          {f.status === 'archived' && <button onClick={() => setRestoring(true)} disabled={restoring}>Restore</button>}
        </td>
      </tr>
      {open && (
        <tr className="details"><td colSpan={6}>
          <dl>
            <dt>Repository</dt><dd>{f.repository}</dd>
            <dt>SHA-256 (original)</dt><dd><code>{f.sha256}</code></dd>
            <dt>SHA-256 (PARW)</dt><dd><code>{f.parwSha256}</code></dd>
            <dt>Current repository footprint</dt><dd>{fmtBytes(f.currentRepoFootprint)} {f.status === 'archived' ? '(pointer only; the original data remains in Git history)' : ''}</dd>
            {f.archivedFromCommitSha && <><dt>Historical commit</dt><dd><code>{f.archivedFromCommitSha}</code></dd></>}
          </dl>
        </td></tr>
      )}
      {err && <tr><td colSpan={6} className="error">{err}</td></tr>}
      {restoring && <tr><td colSpan={6}><RestorePanel path={f.virtualPath} backend={backend} onClose={() => setRestoring(false)} onFinished={onChanged} /></td></tr>}
    </>
  );
}

export function FileTree({ node, backend, onChanged, depth = 0 }: { node: TreeNode; backend: 'local' | 'github'; onChanged: () => void; depth?: number }) {
  const dirs = node.children!.filter((c) => c.type === 'dir');
  const files = node.children!.filter((c) => c.type === 'file');
  return (
    <div className="tree" style={{ marginLeft: depth ? 16 : 0 }}>
      {dirs.map((d) => (
        <details key={d.path} open>
          <summary>📁 {d.name}/</summary>
          <FileTree node={d} backend={backend} onChanged={onChanged} depth={depth + 1} />
        </details>
      ))}
      {files.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Original</th><th>Stored (PARW)</th><th>Compression</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{files.map((f) => <FileRow key={f.path} f={f.file!} backend={backend} onChanged={onChanged} />)}</tbody>
        </table>
      )}
    </div>
  );
}

export { shortSha };
