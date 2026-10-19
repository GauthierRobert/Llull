// In-Canvas feature session: drag handle + value card at the grip, ghost via the shared preview layer. Mounted inside the
// floating-origin group (positions are world space). Ends itself when its target is deselected or removed.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '@ui/store';
import { useFeatureSessionStore } from '@ui/store/featureSessionStore';
import { ScreenAnchor } from '../../screenAnchor/ScreenAnchor';
import { FeatureHandle } from './FeatureHandle';
import { FeatureSessionPanel } from './FeatureSessionPanel';
import { featureStep, handleFrame, minimumValue } from './featurePlan';
import { useFeatureSession } from './useFeatureSession';

const COLORS = { add: '#3b82f6', cut: '#ef4444' } as const;

export function FeatureSessionLayer(): React.ReactElement | null {
  const session = useFeatureSessionStore((s) => s.session);
  const setValue = useFeatureSessionStore((s) => s.setValue);
  const setModeChoice = useFeatureSessionStore((s) => s.setModeChoice);
  const document = useStore((s) => s.document);
  const units = useStore((s) => s.document.units);
  const { plan, commit, cancel } = useFeatureSession();
  const invalidate = useThree((s) => s.invalidate);
  const active = session !== null;

  const targetGone =
    session !== null && (document.entities[session.targetId] === undefined || !document.selection.includes(session.targetId));
  useEffect(() => {
    if (targetGone) cancel();
  }, [targetGone, cancel]);

  // Escape anywhere in the app abandons the session (the value box handles it while focused).
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, cancel]);

  useEffect(() => invalidate(), [session, invalidate]);

  if (session === null || targetGone) return null;
  const frame = handleFrame(document, session.kind, session.targetId);
  if (frame === null) return null;
  const grip: [number, number, number] = [
    frame.origin[0] + frame.axis[0] * session.value,
    frame.origin[1] + frame.axis[1] * session.value,
    frame.origin[2] + frame.axis[2] * session.value,
  ];

  return (
    <group name="feature-session">
      <FeatureHandle
        frame={frame}
        value={session.value}
        step={featureStep(frame)}
        minimum={minimumValue(session.kind)}
        color={COLORS[plan?.tone ?? 'add']}
        onValue={setValue}
        onRelease={commit}
      />
      <ScreenAnchor id="feature-session" position={grip} zIndex={30} className="feature-session-anchor">
        <FeatureSessionPanel
          kind={session.kind}
          unit={units}
          value={session.value}
          modeChoice={session.modeChoice}
          mode={plan?.mode ?? null}
          bodyId={plan?.bodyId ?? null}
          onValue={setValue}
          onModeChoice={setModeChoice}
          onCommit={commit}
          onCancel={cancel}
        />
      </ScreenAnchor>
    </group>
  );
}
