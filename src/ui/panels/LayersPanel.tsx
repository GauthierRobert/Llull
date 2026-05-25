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
      className="layer-row"
      data-testid={`layer-row-${layer.id}`}
      aria-label={`Layer: ${layer.name}`}
    >
      {/* Local viewport visibility toggle (does NOT dispatch a command) */}
      <button
        type="button"
        className={`layer-btn layer-visibility-btn${effectivelyVisible ? '' : ' layer-visibility-btn--hidden'}`}
        onClick={handleLocalVisibilityToggle}
        aria-pressed={effectivelyVisible}
        aria-label={
          effectivelyVisible ? `Hide layer ${layer.name} in viewport` : `Show layer ${layer.name} in viewport`
        }
        title={effectivelyVisible ? 'Hide layer in viewport (local)' : 'Show layer in viewport (local)'}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          {effectivelyVisible ? (
            <>
              <ellipse cx="7" cy="7" rx="5" ry="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <circle cx="7" cy="7" r="1.5" fill="currentColor" />
            </>
          ) : (
            <>
              <ellipse cx="7" cy="7" rx="5" ry="3" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.4" />
              <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </>
          )}
        </svg>
      </button>

      {/* Lock state — read-only indicator (controlled by MCP agent) */}
      <span
        className={`layer-btn layer-lock-indicator${layer.locked ? ' layer-lock-btn--locked' : ''}`}
        aria-label={layer.locked ? `Layer ${layer.name} is locked` : `Layer ${layer.name} is unlocked`}
        title={layer.locked ? 'Locked (set by MCP agent)' : 'Unlocked'}
      >
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true" focusable="false">
          <rect x="1" y="6" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          {layer.locked ? (
            <path d="M3 6 V4 A3 3 0 0 1 9 4 V6" stroke="currentColor" strokeWidth="1.2" fill="none" />
          ) : (
            <path d="M3 6 V4 A3 3 0 0 1 9 4" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.4" />
          )}
        </svg>
      </span>

      {/* Color swatch (read-only) */}
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

      {/* Layer name (read-only) */}
      <span className="layer-name-cell">
        <span className="layer-name-label" aria-label={`Layer name: ${layer.name}`}>
          {layer.name}
        </span>
      </span>

      {/* Entity count badge */}
      <span
        className="layer-entity-count"
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
      className={['layers-panel', className].filter(Boolean).join(' ')}
      aria-label="Layers"
    >
      <div className="layers-panel-header">
        <h2 className="layers-panel-title">Layers</h2>
      </div>

      <ul className="layer-list" aria-label="Layer list" role="list">
        {layerOrder.map((id) => {
          const layer = layers[id];
          if (!layer) return null;
          return (
            <LayerRow
              key={id}
              layer={layer}
              entityCount={entityCounts[id] ?? 0}
            />
          );
        })}
      </ul>
    </aside>
  );
}
