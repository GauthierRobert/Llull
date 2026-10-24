// HTML chrome of B-rep face handle editing: the "Edit faces" chip for a selected exact solid, and while editing a bar with the operation,
// the live value and the backend preview status. Gathers input only; the drag commits one command (faceEditActions).

import { faceHint } from './faceEditHints';
import { Icon } from '@ui/components/Icon';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { useRemotePreviewStore } from '@ui/store/remotePreviewStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { FACE_OPS, canEditFaces, formatFaceValue } from './faceEditModel';

export function FaceEditBar(): React.ReactElement | null {
  const sole = useSoleSelectedEntity();
  const active = useFaceEditStore((s) => s.active);
  const op = useFaceEditStore((s) => s.op);
  const pick = useFaceEditStore((s) => s.pick);
  const value = useFaceEditStore((s) => s.value);
  const status = useRemotePreviewStore((s) => s.status);
  const summary = useRemotePreviewStore((s) => s.summary);
  const hint = faceHint(op, pick !== null, value !== null);
  const editable = canEditFaces(sole);
  if (!editable) return null;
  const edit = useFaceEditStore.getState();
  if (!active) {
    return (
      <div className="feature-start feature-start--faces" role="toolbar" aria-label="Face editing">
        <button type="button" className="feature-start__chip" title="Drag handles on the faces of this solid" onClick={edit.start}>
          Edit faces
        </button>
      </div>
    );
  }
  const refused = status === 'refused' || status === 'unavailable';
  const readout =
    value === null
      ? pick === null
        ? 'Click a face'
        : 'Drag the arrow'
      : status === 'pending'
        ? `${formatFaceValue(op, value)}  previewing\u2026`
        : `${formatFaceValue(op, value)}  ${summary}`;
  return (
    <div className="cage-bar" role="toolbar" aria-label="Face editing">
      <div className="cage-bar__row">
        <div className="cage-bar__group" role="group" aria-label="Operation">
          {FACE_OPS.map((spec, index) => (
            <button
              key={spec.op}
              type="button"
              className="cage-bar__button"
              aria-pressed={op === spec.op}
              title={`${spec.tip} (${index + 1})`}
              onClick={() => edit.setOp(spec.op)}
            >
              {spec.label}
            </button>
          ))}
        </div>
        <button type="button" className="cage-bar__button" onClick={edit.stop} title="Leave face editing (Esc)">
          <Icon name="check" size={12} /> Done
        </button>
      </div>
      <div className={refused && value !== null ? 'cage-bar__status cage-bar__status--error' : 'cage-bar__status'} role="status">
        <span>{readout}</span>
        <span className="cage-bar__hint">{hint}</span>
      </div>
    </div>
  );
}
