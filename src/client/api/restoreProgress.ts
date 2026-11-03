import type { RestoreEvent, RestoreStepName } from './types.ts';

export type StepState = 'waiting' | 'running' | 'success' | 'failed' | 'skipped' | 'aborted';

export interface StepView {
  step: RestoreStepName;
  label: string;
  state: StepState;
  detail?: string;
  ms?: number;
}

export const STEP_LABELS: Record<RestoreStepName, string> = {
  'read-pointer': 'Read pointer',
  'locate-commit': 'Locate historical commit',
  'fetch-historical': 'Download historical object',
  'verify-parw-sha256': 'Verify historical SHA-256',
  'decode-parw': 'Decode PARW',
  'verify-original-sha256': 'Verify original SHA-256',
  'write-local': 'Write reconstructed file',
  'restore-to-tree': 'Restore active repository entry (optional)',
};
export const STEP_ORDER = Object.keys(STEP_LABELS) as RestoreStepName[];

export const STATE_ICON: Record<StepState, string> = {
  waiting: '○', running: '◉', success: '✓', failed: '✗', skipped: '–', aborted: '–',
};
export const STATE_TEXT: Record<StepState, string> = {
  waiting: 'Waiting', running: 'Running', success: 'Success', failed: 'Failed', skipped: 'Skipped', aborted: 'Not run (aborted)',
};

export function initialSteps(opts: { restoreToTree: boolean }): StepView[] {
  return STEP_ORDER.map((step) => ({
    step, label: STEP_LABELS[step],
    state: step === 'restore-to-tree' && !opts.restoreToTree ? 'skipped' : 'waiting',
    detail: step === 'restore-to-tree' && !opts.restoreToTree ? 'not requested' : undefined,
  }));
}

/** Pure reducer: folds one streamed event into the step list. A failure aborts everything after it. */
export function applyEvent(steps: StepView[], ev: RestoreEvent): StepView[] {
  if (ev.type === 'start') return steps.map((s) => (s.step === ev.step ? { ...s, state: 'running' as const } : s));
  if (ev.type === 'step') {
    const failedAt = ev.status === 'failed' ? STEP_ORDER.indexOf(ev.step) : -1;
    return steps.map((s, i) => {
      if (s.step === ev.step) return { ...s, state: ev.status === 'ok' ? 'success' : 'failed', detail: ev.detail, ms: ev.ms };
      if (failedAt >= 0 && i > failedAt && s.state === 'waiting') return { ...s, state: 'aborted' as const };
      return s;
    });
  }
  return steps;
}
