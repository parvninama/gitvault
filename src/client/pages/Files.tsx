import { getTree } from '../api/client.ts';
import { FileTree } from '../components/FileTree.tsx';
import { Async, useAsync } from '../hooks.tsx';

export function Files({ backend }: { backend: 'local' | 'github' }) {
  const state = useAsync(getTree);
  return (
    <section>
      <h2>Files</h2>
      <p className="muted">One virtual volume. Click a file name for its repository, checksums and footprint.</p>
      <Async state={state}>{(tree) => tree.children!.length === 0
        ? <p>No files yet. <a href="#/upload">Upload some</a>.</p>
        : <FileTree node={tree} backend={backend} onChanged={state.reload} />}</Async>
    </section>
  );
}
