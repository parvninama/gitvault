import { useEffect, useRef, useState } from 'react';
import { previewUpload, uploadFile } from '../api/client.ts';
import { fmtBytes, fmtSavings } from '../api/format.ts';
import type { UploadPreview } from '../api/types.ts';

type ItemState = 'checking' | 'ready' | 'blocked' | 'uploading' | 'processing' | 'done' | 'failed';
interface Item { id: number; file: File; state: ItemState; preview?: UploadPreview; progress: number; error?: string }

let nextId = 1;
const pathFor = (folder: string, name: string) => [folder.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');

const STATE_TEXT: Record<ItemState, string> = {
  checking: 'Checking…', ready: 'Ready', blocked: 'Blocked', uploading: 'Uploading', processing: 'Processing on server…', done: 'Uploaded ✓', failed: 'Failed ✗',
};

export function Upload() {
  const [folder, setFolder] = useState('uploads');
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const patch = (id: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const check = async (it: Item) => {
    patch(it.id, { state: 'checking', error: undefined });
    try {
      const pv = await previewUpload(pathFor(folder, it.file.name), it.file, it.file.type || undefined);
      patch(it.id, { preview: pv, state: pv.status === 'ready' ? 'ready' : 'blocked', error: pv.message });
    } catch (e) { patch(it.id, { state: 'failed', error: (e as Error).message }); }
  };

  const onSelect = async (files: FileList | null) => {
    if (!files) return;
    const added: Item[] = [...files].map((file) => ({ id: nextId++, file, state: 'checking', progress: 0 }));
    setItems((xs) => [...xs, ...added]);
    for (const it of added) await check(it); // sequential: each preview ships the file once
  };

  // Re-check when the destination folder changes (debounced), for items not yet uploaded.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(async () => { for (const it of items) if (it.state === 'ready' || it.state === 'blocked') await check(it); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const uploadAll = async () => {
    setBusy(true);
    for (const it of items.filter((x) => x.state === 'ready')) {
      patch(it.id, { state: 'uploading', progress: 0 });
      try {
        await uploadFile(pathFor(folder, it.file.name), it.file, {
          mime: it.file.type || undefined,
          onProgress: (l, t) => patch(it.id, { progress: t ? l / t : 0, state: l >= t ? 'processing' : 'uploading' }),
        });
        patch(it.id, { state: 'done', progress: 1 });
      } catch (e) { patch(it.id, { state: 'failed', error: (e as Error).message }); }
    }
    setBusy(false);
  };

  const ready = items.filter((i) => i.state === 'ready').length;
  return (
    <section>
      <h2>Upload</h2>
      <div className="row">
        <label>Destination folder <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="photos/vacation" /></label>
        <input ref={inputRef} type="file" multiple onChange={(e) => { void onSelect(e.target.files); e.target.value = ''; }} data-testid="file-input" />
      </div>
      <p className="muted">Your local originals are never modified or deleted. Previews encode on the server, so each file is sent once to check and once to upload.</p>
      {items.length > 0 && (
        <table>
          <thead><tr><th>File</th><th>Size → PARW</th><th>Compression</th><th>Target repository</th><th>Status</th></tr></thead>
          <tbody>{items.map((it) => (
            <tr key={it.id} data-testid="upload-row" data-state={it.state}>
              <td>{pathFor(folder, it.file.name)}</td>
              <td>{fmtBytes(it.file.size)}{it.preview?.parwSize != null && <> → {fmtBytes(it.preview.parwSize)}</>}</td>
              <td>{it.preview?.compressionRatio != null ? fmtSavings(it.preview.compressionRatio) : '—'}{it.preview?.compression === 'none' && <span className="muted"> (stored raw)</span>}</td>
              <td>{it.preview?.targetRepository ?? '—'}</td>
              <td>
                {STATE_TEXT[it.state]}
                {(it.state === 'uploading' || it.state === 'processing') && <progress value={it.progress} max={1} />}
                {it.error && <div className="error">{it.error}</div>}
              </td>
            </tr>))}</tbody>
        </table>
      )}
      <div className="row">
        <button onClick={uploadAll} disabled={busy || ready === 0}>Upload All{ready ? ` (${ready})` : ''}</button>
        <button onClick={() => setItems((xs) => xs.filter((x) => x.state === 'uploading' || x.state === 'processing'))} disabled={busy}>Clear list</button>
      </div>
    </section>
  );
}
