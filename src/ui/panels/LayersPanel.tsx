// Layer list (name, visibility, lock, color, count) → add_layer / update_layer / delete_layer. The eye is a LOCAL
// viewport filter (hiddenLayerIds): no command, the document's `layer.visible` never changes.

import React, { memo, useMemo, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useStore, useViewportStore } from '@ui/store';
import { type Layer, DEFAULT_LAYER_ID } from '@core/model/types';
import { Icon } from '@ui/components/Icon';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';
import { DeleteButton, IconButton, PanelHeader } from '@ui/panels/PanelParts';
import { CommitInput } from '@ui/panels/propertyFields';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { orderedValues } from '@ui/panels/orderedValues';

function useLayerEntityCounts(): Record<string, number> {
  const entities = useStore((s) => s.document.entities);
  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entity of Object.values(entities)) {
      if (entity) {
        counts[entity.layerId] = (counts[entity.layerId] ?? 0) + 1;
      }
    }
    return counts;
  }, [entities]);
}

const LayerRow = memo(function LayerRow({ layer, entityCount }: { layer: Layer; entityCount: number }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const isLocallyHidden = useViewportStore((s) => s.hiddenLayerIds.has(layer.id));
  const toggleLayerVisibility = useViewportStore((s) => s.toggleLayerVisibility);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const effectivelyVisible = layer.visible && !isLocallyHidden;
  const isDefaultLayer = layer.id === DEFAULT_LAYER_ID;

  return (
    <li
      className={`panel__row layer-row${effectivelyVisible ? '' : ' layer-row--hidden'}`}
      data-testid={`layer-row-${layer.id}`}
      aria-label={`Layer: ${layer.name}`}
    >
      <IconButton
        icon={effectivelyVisible ? 'eye' : 'eyeOff'}
        size={14}
        className={classNames('layer-visibility-btn', !effectivelyVisible && 'layer-visibility-btn--hidden')}
        pressed={effectivelyVisible}
        label={effectivelyVisible ? `Hide layer ${layer.name} in viewport` : `Show layer ${layer.name} in viewport`}
        title={effectivelyVisible ? 'Hide layer in viewport (local)' : 'Show layer in viewport (local)'}
        onClick={() => toggleLayerVisibility(layer.id)}
      />

      <IconButton
        icon={layer.locked ? 'lock' : 'unlock'}
        size={12}
        className={classNames('layer-lock', layer.locked && 'layer-lock--locked')}
        pressed={layer.locked}
        label={layer.locked ? `Unlock layer ${layer.name}` : `Lock layer ${layer.name}`}
        title={layer.locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}
        onClick={() => dispatch('update_layer', { id: layer.id, locked: !layer.locked })}
      />

      {layer.color != null ? (
        <span
          role="img"
          className="layer-color-swatch"
          style={{ background: layer.color }}
          title={`Layer color: ${layer.color}`}
          aria-label={`Layer color: ${layer.color}`}
        />
      ) : (
        <span className="layer-color-swatch layer-color-swatch--none" aria-hidden="true" />
      )}

      {renaming ? (
        <CommitInput
          className="layer-name-input"
          label={`Rename layer ${layer.name}`}
          value={layer.name}
          autoFocus
          onCommit={(name) => {
            if (name.trim() !== '') dispatch('update_layer', { id: layer.id, name: name.trim() });
          }}
          onFinish={() => setRenaming(false)}
        />
      ) : (
        <span className="panel__row-main layer-name">{layer.name}</span>
      )}

      <span className="panel__row-meta" title={`${entityCount} ${entityCount === 1 ? 'entity' : 'entities'} on this layer`}>
        {entityCount}
        <span className="visually-hidden">{entityCount === 1 ? ' entity' : ' entities'}</span>
      </span>

      <span className="panel__row-actions">
        <IconButton
          icon="parameters"
          size={12}
          label={`Rename layer ${layer.name}`}
          title="Rename layer"
          onClick={() => setRenaming(true)}
        />
        <DeleteButton
          size={12}
          disabled={isDefaultLayer}
          label={`Delete layer ${layer.name}`}
          title={isDefaultLayer ? 'The default layer cannot be deleted' : 'Delete layer'}
          onDelete={() => setConfirmingDelete(true)}
        />
      </span>

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete layer "${layer.name}"?`}
          message={
            entityCount === 0
              ? 'The layer is empty.'
              : `${entityCount} ${entityCount === 1 ? 'entity moves' : 'entities move'} to the default layer.`
          }
          confirmLabel="Delete layer"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            dispatch('delete_layer', { id: layer.id });
          }}
        />
      )}
    </li>
  );
});

function AddLayerForm(): React.ReactElement {
  const [name, setName] = useState('');
  const dispatchThen = useDispatchThen();
  const trimmed = name.trim();

  return (
    <form
      className="panel__form"
      aria-label="Add layer"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed === '') return;
        dispatchThen('add_layer', { name: trimmed }, () => setName(''));
      }}
    >
      <div className="param-add-fields">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new layer name"
          aria-label="New layer name"
          autoComplete="off"
        />
        <button type="submit" className="btn btn--primary" disabled={trimmed === ''} aria-label="Add layer" title="Add layer">
          <Icon name="plus" size={14} />
        </button>
      </div>
    </form>
  );
}

export function LayersPanel({ className }: { className?: string }): React.ReactElement {
  const layers = useStore((s) => s.document.layers);
  const layerOrder = useStore((s) => s.document.layerOrder);
  const entityCounts = useLayerEntityCounts();

  return (
    <aside className={classNames('panel layers-panel', className)} aria-label="Layers">
      <PanelHeader title="Layers" count={layerOrder.length} countLabel={`${layerOrder.length} layers`} />

      <ul className="panel__list" aria-label="Layer list" role="list">
        {orderedValues(layerOrder, layers).map((layer) => (
          <LayerRow key={layer.id} layer={layer} entityCount={entityCounts[layer.id] ?? 0} />
        ))}
      </ul>

      <AddLayerForm />
    </aside>
  );
}
