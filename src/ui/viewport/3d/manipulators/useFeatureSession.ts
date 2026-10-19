// Drives the active feature session: every value change re-plans against the live document and asks the preview controller for a
// debounced dry run; `commit` dispatches the plan's single call once; `cancel` discards everything.

import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '@ui/store';
import { useFeatureSessionStore } from '@ui/store/featureSessionStore';
import { usePreviewStore } from '@ui/store/previewStore';
import { usePreviewController } from '@ui/preview/usePreviewController';
import { type FeaturePlan, planForSession } from './featurePlan';

export interface FeatureSessionApi {
  plan: FeaturePlan | null;
  commit(): void;
  cancel(): void;
}

export function useFeatureSession(): FeatureSessionApi {
  const session = useFeatureSessionStore((s) => s.session);
  const document = useStore((s) => s.document);
  const plan = useMemo(() => (session === null ? null : planForSession(document, session)), [session, document]);
  const controller = usePreviewController(plan?.tone ?? 'add');
  const active = session !== null;

  // Idle sessions leave the ghost alone (a palette dialog may own it).
  useEffect(() => {
    if (!active) return;
    if (plan === null) controller.cancel();
    else controller.request(plan.preview.name, plan.preview.params);
  }, [active, plan, controller]);

  const commit = useCallback((): void => {
    const live = useFeatureSessionStore.getState().session;
    if (live === null) return;
    const latest = planForSession(useStore.getState().document, live);
    // A dry run that was refused would be refused again: keep the session open so the refusal stays on screen.
    if (latest === null || usePreviewStore.getState().outcome?.ok === false) return;
    controller.commit(latest.commit.name, latest.commit.params, { selectAffected: true });
    useFeatureSessionStore.getState().end();
  }, [controller]);

  const cancel = useCallback((): void => {
    controller.cancel();
    useFeatureSessionStore.getState().end();
  }, [controller]);

  return { plan, commit, cancel };
}
