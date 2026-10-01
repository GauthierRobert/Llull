/**
 * @layer ui/panels
 *
 * LayersPanel — a right-docked read-only layer list.
 *
 * Displays: layer name, visibility state, lock state, color swatch, entity count.
 *
 * llull is now a LIVE READ-ONLY VIEWER: add/rename/delete/lock controls and
 * undo/redo buttons are removed. Layer state is driven exclusively by the MCP
 * agent; this panel only reflects what is in the document.
 *
 * Layer visibility (eye icon) is kept as a purely LOCAL viewport filter — it
 * toggles useViewportStore.hiddenLayerIds, which the renderers read, without
 * dispatching any command. This avoids desync: the server's authoritative layer
 * visible flag is unchanged; the local filter is a rendering convenience only.
 *
 * PRIME DIRECTIVE: this panel NEVER builds a Layer or dispatches commands.
 * (architecture L1, react R1)
 */

import React, { useCallback } from 'react';
import { useStore, useViewportStore } from '@ui/store';
import type { Layer } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { PanelHeader } from '@ui/panels/PanelParts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useLayerEntityCounts(): Record<string, number> {
  const entities = useStore((s) => s.document.entities);
  const counts: Record<string, number> = {};
  for (const entity of Object.values(entities)) {
    if (entity) {
      counts[entity.layerId] = (counts[entity.layerId] ?? 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Layer row — read-only with local viewport visibility toggle
// ---------------------------------------------------------------------------

interface LayerRowProps {
  layer: Layer;
  entityCount: number;
}

function LayerRow({ layer, entityCount }: LayerRowProps): React.ReactElement {
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const toggleLayerVisibility = useViewportStore((s) => s.toggleLayerVisibility);

  // Local viewport visibility: starts from the document's layer.visible, then
  // the user can toggle it locally without touching the server document.
  const isLocallyHidden = hiddenLayerIds.has(layer.id);
  const effectivelyVisible = layer.visible && !isLocallyHidden;

  const handleLocalVisibilityToggle = useCallback(() => {
    toggleLayerVisibility(layer.id);
  }, [layer.id, toggleLayerVisibility]);

  return (
    <li
      className={`panel__row layer-row${effectivelyVisible ? '' : ' layer-row--hidden'}`}
      data-testid={`layer-row-${layer.id}`}
      aria-label={`Layer: ${layer.name}`}
    >
      <button
        type="button"
        className={`icon-btn layer-visibility-btn${effectivelyVisible ? '' : ' layer-visibility-btn--hidden'}`}
        onClick={handleLocalVisibilityToggle}
        aria-pressed={effectivelyVisible}
        aria-label={
          effectivelyVisible
            ? `Hide layer ${layer.name} in viewport`
            : `Show layer ${layer.name} in viewport`
        }
        title={
          effectivelyVisible ? 'Hide layer in viewport (local)' : 'Show layer in viewport (local)'
        }
      >
        <Icon name={effectivelyVisible ? 'eye' : 'eyeOff'} size={14} />
      </button>

      <span
        className={`layer-lock${layer.locked ? ' layer-lock--locked' : ''}`}
        aria-label={
          layer.locked ? `Layer ${layer.name} is locked` : `Layer ${layer.name} is unlocked`
        }
        title={layer.locked ? 'Locked (set by MCP agent)' : 'Unlocked'}
      >
        <Icon name={layer.locked ? 'lock' : 'unlock'} size={12} />
      </span>

      {layer.color != null ? (
        <span
          className="layer-color-swatch"
          style={{ background: layer.color }}
          title={`Layer color: ${layer.color}`}
          aria-label={`Layer color: ${layer.color}`}
        />
      ) : (
        <span className="layer-color-swatch layer-color-swatch--none" aria-hidden="true" />
      )}

      <span className="panel__row-main layer-name" aria-label={`Layer name: ${layer.name}`}>
        {layer.name}
      </span>

      <span
        className="panel__row-meta"
        title={`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'} on this layer`}
        aria-label={`${entityCount} entities`}
      >
        {entityCount}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// LayersPanel
// ---------------------------------------------------------------------------

export interface LayersPanelProps {
  className?: string;
}

export function LayersPanel({ className }: LayersPanelProps): React.ReactElement {
  const layers = useStore((s) => s.document.layers);
  const layerOrder = useStore((s) => s.document.layerOrder);
  const entityCounts = useLayerEntityCounts();

  return (
    <aside
      className={['panel layers-panel', className].filter(Boolean).join(' ')}
      aria-label="Layers"
    >
      <PanelHeader
        title="Layers"
        count={layerOrder.length}
        countLabel={`${layerOrder.length} layers`}
      />

      <ul className="panel__list" aria-label="Layer list" role="list">
        {layerOrder.map((id) => {
          const layer = layers[id];
          if (!layer) return null;
          return <LayerRow key={id} layer={layer} entityCount={entityCounts[id] ?? 0} />;
        })}
      </ul>
    </aside>
  );
}
