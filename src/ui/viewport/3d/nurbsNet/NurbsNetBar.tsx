// HTML chip of the control-net overlay: the "Poles" toggle for a selected NURBS curve or surface and, while shown, what dragging does; with poles
// selected, the soft-selection falloff (radius in pole indices, weight curve) and the box-selection rectangle. Gathers input only; a pole drag
// commits one move_poles command (netActions).

import { FALLOFF_SHAPES, type FalloffShape } from '@core/lib/falloff';
import { usePreviewStore } from '@ui/store/previewStore';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { isNurbsNetEntity, polesOf } from './controlNet';

function MarqueeBox(): React.ReactElement | null {
  const marquee = useNurbsNetStore((s) => s.marquee);
  if (marquee === null) return null;
  return (
    <div
      className="net-marquee"
      data-testid="net-marquee"
      style={{
        left: Math.min(marquee.x0, marquee.x1),
        top: Math.min(marquee.y0, marquee.y1),
        width: Math.abs(marquee.x1 - marquee.x0),
        height: Math.abs(marquee.y1 - marquee.y0),
      }}
    />
  );
}

function Falloff(): React.ReactElement {
  const falloff = useNurbsNetStore((s) => s.falloff);
  const selected = useNurbsNetStore((s) => s.selected);
  const net = useNurbsNetStore.getState();
  return (
    <div className="feature-start feature-start--falloff" role="group" aria-label="Pole selection">
      <span className="feature-start__note" aria-live="polite">
        {selected.length === 0
          ? 'Shift-click or Shift-drag a box to select poles'
          : `${selected.length} pole${selected.length === 1 ? '' : 's'} selected`}
      </span>
      <label className="feature-start__note">
        Falloff
        <input
          className="vp-input net-falloff__radius"
          type="number"
          min={0}
          step={0.5}
          value={falloff.radius}
          aria-label="Falloff radius (poles)"
          title="How many pole indices the move spreads beyond the selection (0 = only the selected poles)"
          onChange={(e) => net.setFalloff({ radius: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <select
        className="vp-select"
        value={falloff.shape}
        aria-label="Falloff profile"
        disabled={falloff.radius <= 0}
        onChange={(e) => net.setFalloff({ shape: e.target.value as FalloffShape })}
      >
        {FALLOFF_SHAPES.map((shape) => (
          <option key={shape} value={shape}>
            {shape}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="feature-start__chip"
        disabled={selected.length === 0}
        onClick={() => net.setSelected([])}
        title="Deselect every pole"
      >
        Clear
      </button>
    </div>
  );
}

export function NurbsNetBar(): React.ReactElement | null {
  const sole = useSoleSelectedEntity();
  const visible = useNurbsNetStore((s) => s.visible);
  const dragging = useNurbsNetStore((s) => s.drag !== null);
  const outcome = usePreviewStore((s) => s.outcome);
  if (!isNurbsNetEntity(sole)) return null;
  const count = polesOf(sole).length;
  const refused = dragging && outcome !== null && !outcome.ok;
  return (
    <>
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
      {visible && <Falloff />}
      <MarqueeBox />
    </>
  );
}
