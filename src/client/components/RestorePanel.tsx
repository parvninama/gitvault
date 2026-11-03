import { useState } from 'react';
import { restoreFile } from '../api/client.ts';
import { applyEvent, initialSteps, STATE_ICON, STATE_TEXT } from '../api/restoreProgress.ts';
import type { StepView } from '../api/restoreProgress.ts';
import type { RestoreOutcome } from '../api/types.ts';
import { fmtBytes } from '../api/format.ts';

export function RestorePanel({ path, backend, onClose, onFinished }: { path: string; backend: 'local' | 'github'; onClose: () => void; onFinished: () => void }) {
  const [restoreToTree, setRestoreToTree] = useState(false);
  const [slow, setSlow] = useState(false);
  const [steps, setSteps] = useState<StepView[]>(() => initialSteps({ restoreToTree: false }));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);

  const start = async () => {
    setOutcome(null);
    setRunning(true);
    let s = initialSteps({ restoreToTree });
    setSteps(s);
    const result = await restoreFile(path, { restoreToTree, slowMs: slow ? 400 : 0 }, (e) => { s = applyEvent(s, e); setSteps(s); });
    setOutcome(result);
    setRunning(false);
    if (result.ok) onFinished();
  };

  return (
    <div className="panel" data-testid="restore-panel">
      <h3>Restore {path}</h3>
      {!outcome && !running && (
        <div className="row">
          <label><input type="checkbox" checked={restoreToTree} onChange={(e) => { setRestoreToTree(e.target.checked); setSteps(initialSteps({ restoreToTree: e.target.checked })); }} /> Also put the file back in the active repository (step 8)</label>
          {backend === 'local' && <label><input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> Slow motion (adds 400 ms per step, local demo only)</label>}
        </div>
      )}
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.step} className={`step step-${s.state}`} data-state={s.state}>
            <span className="icon" aria-hidden>{STATE_ICON[s.state]}</span>
            <span className="label">{s.label}</span>
            <span className="state">{STATE_TEXT[s.state]}</span>
            {s.detail && <span className={s.state === 'failed' ? 'detail fail' : 'detail'}>{s.detail}</span>}
            {s.ms !== undefined && <span className="muted"> {s.ms} ms</span>}
          </li>
        ))}
      </ol>
      {outcome?.ok && <div className="ok" role="status">Restored and verified. Written to <code>{outcome.outputPath}</code> ({fmtBytes(outcome.file.originalSize)}).{outcome.restoredToTree ? ' The file is active in the repository again.' : ' It is still archived in the repository tree.'}</div>}
      {outcome && !outcome.ok && <div className="error" role="alert">Restore aborted{outcome.failedStep ? ` at “${outcome.failedStep}”` : ''}: {outcome.message.replace(/^Restore failed at "[^"]+": /, '')}</div>}
      <div className="row">
        {!outcome?.ok && <button onClick={start} disabled={running}>{running ? 'Restoring…' : outcome ? 'Try again' : 'Start restore'}</button>}
        <button onClick={onClose} disabled={running}>{outcome?.ok ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}
