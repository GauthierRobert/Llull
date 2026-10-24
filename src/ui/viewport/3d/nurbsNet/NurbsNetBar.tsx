// HTML chip of the control-net overlay: the "Poles" toggle for a selected NURBS curve or surface and, while shown, what dragging does.
// Gathers input only; a pole drag commits one move_poles command (netActions).

import { usePreviewStore } from '@ui/store/previewStore';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { isNurbsNetEntity, polesOf } from './controlNet';

export function NurbsNetBar(): React.ReactElement | null {
  const sole = useSoleSelectedEntity();
  const visible = useNurbsNetStore((s) => s.visible);
  const dragging = useNurbsNetStore((s) => s.drag !== null);
  const outcome = usePreviewStore((s) => s.outcome);
  if (!isNurbsNetEntity(sole)) return null;
  const count = polesOf(sole).length;
  const refused = dragging && outcome !== null && !outcome.ok;
  return (
    <div className="feature-start feature-start--net" role="toolbar" aria-label="Control net">
      <button
        type="button"
        className="feature-start__chip"
        aria-pressed={visible}
        title={`Show the control ${sole.kind === 'nurbs_curve' ? 'polygon' : 'net'} and poles (${count})`}
        onClick={useNurbsNetStore.getState().toggle}
      >
        {visible ? 'Hide poles' : 'Show poles'}
      </button>
      {visible && (
        <span className={refused ? 'feature-start__note feature-start__note--error' : 'feature-start__note'} role="status">
          {refused ? outcome.summary : 'Drag a pole in the view plane; X / Y / Z lock an axis, Esc cancels'}
        </span>
      )}
    </div>
  );
}
