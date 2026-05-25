/**
 * @layer ui/panels
 *
 * LayersPanel — a right-docked panel for managing document layers.
 *
 * Rows: name (editable), visibility toggle, lock toggle, color swatch (read-only),
 * entity count, delete button (disabled for the default layer).
 *
 * Commands wired (all from L1):
 *   - add_layer       → "Add Layer" button
 *   - rename_layer    → blur / Enter on the name input
 *   - set_layer_visibility → eye icon button
 *   - set_layer_lock       → lock icon button
 *   - delete_layer         → trash button (disabled for layer-default)
 *
 * NOTE: there is no `set_layer_color` command in the registry, so the color
 * swatch is rendered read-only (the color can be set at creation time via add_layer).
 *
 * Undo/redo buttons are provided in the panel header section; they call the
 * store's undo()/redo() directly (not via dispatch — they are store actions).
 *
 * PRIME DIRECTIVE: this panel NEVER builds a Layer or mutates the document.
 * All mutations go through `store.dispatch(name, params)`. (architecture L1, react R1)
 */

import React, { useState, useCallback, useRef } from 'react';
import { useStore } from '@ui/store';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import type { Layer } from '@core/model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count entities on a specific layer. */
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
// Undo / Redo buttons
// ---------------------------------------------------------------------------

function UndoRedoButtons(): React.ReactElement {
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

  return (
    <div className="layers-undoredo" role="group" aria-label="Undo and redo">
      <button
        type="button"
        className="layers-undoredo-btn"
        onClick={undo}
        disabled={undoStack.length === 0}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        {/* Left-pointing arrow */}
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
          <path
            d="M2 5.5 L5 2 L5 4 C8.5 4 10 5.5 10 8.5 C9 6.5 7.5 5.5 5 5.5 L5 7.5 Z"
            fill="currentColor"
          />
        </svg>
        Undo
      </button>
      <button
        type="button"
        className="layers-undoredo-btn"
        onClick={redo}
        disabled={redoStack.length === 0}
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
      >
        Redo
        {/* Right-pointing arrow */}
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
          <path
            d="M11 5.5 L8 2 L8 4 C4.5 4 3 5.5 3 8.5 C4 6.5 5.5 5.5 8 5.5 L8 7.5 Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layer row
// ---------------------------------------------------------------------------

interface LayerRowProps {
  layer: Layer;
  entityCount: number;
  onDispatch: (name: string, params: unknown) => void;
}

function LayerRow({ layer, entityCount, onDispatch }: LayerRowProps): React.ReactElement {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(layer.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDefault = layer.id === DEFAULT_LAYER_ID;

  // Commit rename when the user blurs or presses Enter.
  const commitRename = useCallback(() => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== layer.name) {
      onDispatch('rename_layer', { id: layer.id, name: trimmed });
    } else {
      // Revert local state if empty or unchanged.
      setNameValue(layer.name);
    }
    setEditingName(false);
  }, [nameValue, layer.id, layer.name, onDispatch]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setNameValue(layer.name);
        setEditingName(false);
      }
    },
    [commitRename, layer.name],
  );

  const handleNameClick = useCallback(() => {
    setNameValue(layer.name);
    setEditingName(true);
    // Focus is handled by the useEffect pattern — we inline it here with a timeout.
    setTimeout(() => inputRef.current?.select(), 0);
  }, [layer.name]);

  const handleVisibilityToggle = useCallback(() => {
    onDispatch('set_layer_visibility', { id: layer.id, visible: !layer.visible });
  }, [layer.id, layer.visible, onDispatch]);

  const handleLockToggle = useCallback(() => {
    onDispatch('set_layer_lock', { id: layer.id, locked: !layer.locked });
  }, [layer.id, layer.locked, onDispatch]);

  const handleDelete = useCallback(() => {
    onDispatch('delete_layer', { id: layer.id });
  }, [layer.id, onDispatch]);

  return (
    <li
      className="layer-row"
      data-testid={`layer-row-${layer.id}`}
      aria-label={`Layer: ${layer.name}`}
    >
      {/* Visibility toggle (eye icon) */}
      <button
        type="button"
        className={`layer-btn layer-visibility-btn${layer.visible ? '' : ' layer-visibility-btn--hidden'}`}
        onClick={handleVisibilityToggle}
        aria-pressed={layer.visible}
        aria-label={layer.visible ? `Hide layer ${layer.name}` : `Show layer ${layer.name}`}
        title={layer.visible ? 'Hide layer' : 'Show layer'}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          {layer.visible ? (
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

      {/* Lock toggle (lock icon) */}
      <button
        type="button"
        className={`layer-btn layer-lock-btn${layer.locked ? ' layer-lock-btn--locked' : ''}`}
        onClick={handleLockToggle}
        aria-pressed={layer.locked}
        aria-label={layer.locked ? `Unlock layer ${layer.name}` : `Lock layer ${layer.name}`}
        title={layer.locked ? 'Unlock layer' : 'Lock layer'}
      >
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true" focusable="false">
          <rect x="1" y="6" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          {layer.locked ? (
            <path d="M3 6 V4 A3 3 0 0 1 9 4 V6" stroke="currentColor" strokeWidth="1.2" fill="none" />
          ) : (
            <path d="M3 6 V4 A3 3 0 0 1 9 4" stroke="currentColor" strokeWidth="1.2" fill="none" opacity="0.4" />
          )}
        </svg>
      </button>

      {/* Color swatch (read-only — no set_layer_color command exists) */}
      {layer.color != null ? (
        <span
          className="layer-color-swatch"
          style={{ background: layer.color }}
          title={`Layer color: ${layer.color} (read-only; set at layer creation)`}
          aria-label={`Layer color: ${layer.color}`}
        />
      ) : (
        <span className="layer-color-swatch layer-color-swatch--none" aria-hidden="true" />
      )}

      {/* Name — click to edit inline */}
      <span className="layer-name-cell">
        {editingName ? (
          <input
            ref={inputRef}
            className="layer-name-input"
            type="text"
            value={nameValue}
            aria-label={`Rename layer ${layer.name}`}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleNameKeyDown}
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="layer-name-btn"
            onClick={handleNameClick}
            title="Click to rename"
            aria-label={`Layer name: ${layer.name}. Click to rename.`}
          >
            {layer.name}
          </button>
        )}
      </span>

      {/* Entity count badge */}
      <span
        className="layer-entity-count"
        title={`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'} on this layer`}
        aria-label={`${entityCount} entities`}
      >
        {entityCount}
      </span>

      {/* Delete button — hidden/disabled for the default layer */}
      <button
        type="button"
        className="layer-btn layer-delete-btn"
        onClick={handleDelete}
        disabled={isDefault}
        aria-label={`Delete layer ${layer.name}`}
        title={isDefault ? 'Cannot delete the default layer' : `Delete layer ${layer.name}`}
        aria-disabled={isDefault}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Add-layer form
// ---------------------------------------------------------------------------

interface AddLayerFormProps {
  onDispatch: (name: string, params: unknown) => void;
}

function AddLayerForm({ onDispatch }: AddLayerFormProps): React.ReactElement {
  const [name, setName] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      onDispatch('add_layer', { name: trimmed });
      setName('');
    },
    [name, onDispatch],
  );

  return (
    <form className="layer-add-form" onSubmit={handleSubmit} aria-label="Add layer">
      <input
        className="layer-add-input"
        type="text"
        placeholder="New layer name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="New layer name"
      />
      <button
        type="submit"
        className="layer-add-btn"
        disabled={name.trim().length === 0}
        aria-label="Add layer"
        title="Add layer"
      >
        Add
      </button>
    </form>
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
  const dispatch = useStore((s) => s.dispatch);

  const entityCounts = useLayerEntityCounts();

  const handleDispatch = useCallback(
    (name: string, params: unknown) => {
      dispatch(name, params);
    },
    [dispatch],
  );

  return (
    <aside
      className={['layers-panel', className].filter(Boolean).join(' ')}
      aria-label="Layers"
    >
      {/* Panel header with title + undo/redo */}
      <div className="layers-panel-header">
        <h2 className="layers-panel-title">Layers</h2>
        <UndoRedoButtons />
      </div>

      {/* Layer list */}
      <ul className="layer-list" aria-label="Layer list" role="list">
        {layerOrder.map((id) => {
          const layer = layers[id];
          if (!layer) return null;
          return (
            <LayerRow
              key={id}
              layer={layer}
              entityCount={entityCounts[id] ?? 0}
              onDispatch={handleDispatch}
            />
          );
        })}
      </ul>

      {/* Add-layer form */}
      <div className="layers-panel-footer">
        <AddLayerForm onDispatch={handleDispatch} />
      </div>
    </aside>
  );
}
