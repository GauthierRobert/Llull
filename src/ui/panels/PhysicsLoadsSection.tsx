// Mechanisms › Loads & forces: everything that acts on the rigid-body model (weights, joints and gears, motor torques, propeller thrust)
// as one review list with the setup behind each value, and the switches for the viewport overlay (DynamicsLoadsOverlay): all on/off,
// value labels, per kind and per load. Picking a load emphasises it in the 3D view.

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { isLoadDrawn, useLoadOverlayStore } from '@ui/store/loadOverlayStore';
import { useDynamicsLoads } from '@ui/hooks/useDynamicsLoads';
import { LOAD_LAYERS, formatQuantity, type LoadItem, type LoadLayer } from '@core/dynamics/dynamicsLoads';
import { LOAD_COLORS, LOAD_LAYER_LABELS } from '@ui/dynamicsLoads';
import { IconButton, PanelSection } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { loadFocus } from '@ui/panels/mechanismFocus';

function Swatch({ layer }: { layer: LoadLayer }): React.ReactElement {
  return <span className="loads-swatch" style={{ background: LOAD_COLORS[layer] }} aria-hidden="true" />;
}

function LoadRow({ item }: { item: LoadItem }): React.ReactElement {
  const overlay = useLoadOverlayStore();
  const drawn = isLoadDrawn(overlay, item);
  const focused = overlay.focusedId === item.id;
  const focusItem = useFocusItem();
  const document = useStore((s) => s.document);
  return (
    <li
      className={classNames('panel__row loads-row', focused && 'panel__row--selected', !drawn && 'loads-row--hidden')}
      data-testid={`load-${item.id}`}
    >
      <button
        type="button"
        className="loads-row__main"
        aria-pressed={focused}
        title="Show on the model: parts, force glyph and value"
        onClick={() => {
          overlay.focus(focused ? null : item.id);
          focusItem(loadFocus(document, item));
        }}
      >
        <span className="loads-row__line">
          <Swatch layer={item.layer} />
          <span className="panel__row-main">{item.title}</span>
          <span className="loads-row__value">{item.value}</span>
        </span>
        <span className="loads-row__detail">{item.detail}</span>
      </button>
      <IconButton
        icon={overlay.hiddenIds.includes(item.id) ? 'eyeOff' : 'eye'}
        label={`${overlay.hiddenIds.includes(item.id) ? 'Show' : 'Hide'} ${item.title} in the 3D view`}
        pressed={!overlay.hiddenIds.includes(item.id)}
        onClick={() => overlay.toggleLoad(item.id)}
      />
    </li>
  );
}

function OverlaySwitches({ counts }: { counts: Readonly<Record<LoadLayer, number>> }): React.ReactElement {
  const { shown, labels, hiddenLayers, setShown, setLabels, toggleLayer } = useLoadOverlayStore();
  return (
    <div className="loads-switches">
      <div className="loads-switches__row">
        <label className="loads-check">
          <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} data-testid="loads-shown" />
          Show in 3D view
        </label>
        <label className="loads-check">
          <input type="checkbox" checked={labels} disabled={!shown} onChange={(event) => setLabels(event.target.checked)} />
          Values
        </label>
      </div>
      <div className="loads-switches__row" role="group" aria-label="Load kinds drawn">
        {LOAD_LAYERS.filter((layer) => counts[layer] > 0).map((layer) => (
          <button
            key={layer}
            type="button"
            className="loads-chip"
            aria-pressed={!hiddenLayers.includes(layer)}
            disabled={!shown}
            onClick={() => toggleLayer(layer)}
            data-testid={`loads-layer-${layer}`}
          >
            <Swatch layer={layer} />
            {LOAD_LAYER_LABELS[layer]} <span className="loads-chip__count">{counts[layer]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function GravityLine(): React.ReactElement | null {
  const gravity = useStore((s) => s.document.dynamics?.gravity);
  if (gravity === undefined) return null;
  const g = Math.hypot(...gravity);
  return (
    <p className="panel__section-hint" data-testid="loads-gravity">
      Gravity {formatQuantity(g)} m/s² along ({gravity.map((c) => formatQuantity(g > 0 ? c / g : 0, 2)).join(', ')}).
    </p>
  );
}

/** Weight of the bodies that move (fixed ones rest on the ground). */
function movingWeight(items: readonly LoadItem[]): number {
  return items.filter((item) => item.layer === 'gravity').reduce((sum, item) => sum + (item.magnitude ?? 0), 0);
}

export function PhysicsLoadsSection(): React.ReactElement | null {
  const { current } = useDynamicsLoads();
  if (current.length === 0) return null;
  const counts = Object.fromEntries(LOAD_LAYERS.map((layer) => [layer, current.filter((item) => item.layer === layer).length])) as Record<
    LoadLayer,
    number
  >;
  return (
    <PanelSection
      collapsible
      title="Loads & forces"
      count={current.length}
      countLabel={`${current.length} loads`}
      hint="What the AI set up, with the numbers behind it. Pick a row to emphasise it in the 3D view; play a run to see the values live."
      testId="mechanisms-section-loads"
    >
      <GravityLine />
      <OverlaySwitches counts={counts} />
      {LOAD_LAYERS.filter((layer) => counts[layer] > 0).map((layer) => (
        <div key={layer} className="loads-group">
          <h4 className="loads-group__title">
            {LOAD_LAYER_LABELS[layer]}
            {layer === 'gravity' && <span className="loads-group__total">moving {formatQuantity(movingWeight(current))} N</span>}
          </h4>
          <ul className="panel__list" aria-label={LOAD_LAYER_LABELS[layer]}>
            {current
              .filter((item) => item.layer === layer)
              .map((item) => (
                <LoadRow key={item.id} item={item} />
              ))}
          </ul>
        </div>
      ))}
    </PanelSection>
  );
}
