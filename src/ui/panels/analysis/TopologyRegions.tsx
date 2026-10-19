// Keep-in (stays solid) and keep-out (stays empty) regions of one study. Every edit replaces the list through set_topology_regions.

import React, { useState } from 'react';
import type { TopologyRegion, TopologyStudy } from '@core/model/topology';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';

type RegionList = 'keepIn' | 'keepOut';

const LISTS: readonly { key: RegionList; title: string }[] = [
  { key: 'keepIn', title: 'Keep solid' },
  { key: 'keepOut', title: 'Keep empty' },
];

function describeRegion(region: TopologyRegion): string {
  if (region.kind === 'entity') return `solid ${region.entityId}`;
  if (region.kind === 'box') return `box [${region.min.join(', ')}] to [${region.max.join(', ')}]`;
  return `${region.depthVoxels} voxel layer(s) at ${region.target.entityId}`;
}

/** Regions are sent back as the schema's input shape; a stored region is already valid input. */
const asInput = (regions: readonly TopologyRegion[]): TopologyRegion[] => [...regions];

const ZERO_BOX = ['', '', '', '', '', ''] as const;

function BoxForm({ onAdd }: { onAdd: (min: [number, number, number], max: [number, number, number]) => void }): React.ReactElement {
  const [box, setBox] = useState<readonly string[]>(ZERO_BOX);
  const numbers = box.map(Number);
  const valid = box.every((text) => text !== '') && numbers.every(Number.isFinite);
  const labels = ['min x', 'min y', 'min z', 'max x', 'max y', 'max z'];
  return (
    <div className="analysis__controls">
      {labels.map((label, index) => (
        <label key={label} className="field">
          <span className="field__label">{label}</span>
          <input
            type="number"
            step="any"
            aria-label={label}
            value={box[index] ?? ''}
            onChange={(e) => setBox(box.map((text, at) => (at === index ? e.target.value : text)))}
          />
        </label>
      ))}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={!valid}
        onClick={() => onAdd([numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0], [numbers[3] ?? 0, numbers[4] ?? 0, numbers[5] ?? 0])}
      >
        Add box
      </button>
    </div>
  );
}

export function TopologyRegions({ study }: { study: TopologyStudy }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.document.selection);
  const replace = (list: RegionList, regions: TopologyRegion[]): void =>
    dispatch('set_topology_regions', { studyId: study.id, [list]: regions });

  return (
    <PanelSection
      title="Regions"
      hint="Keep-solid regions are never removed (interfaces, bolt bosses); keep-empty regions stay clear."
      collapsible
      defaultOpen={false}
    >
      {LISTS.map(({ key, title }) => (
        <div key={key} data-testid={`topology-${key}`}>
          <h4 className="analysis__subtitle">{title}</h4>
          {study[key].length === 0 ? (
            <p className="analysis__none">None</p>
          ) : (
            <ul className="analysis__items" aria-label={title}>
              {study[key].map((region, index) => (
                <li key={`${index}-${describeRegion(region)}`} className="analysis__item">
                  <span className="analysis__item-name">{describeRegion(region)}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-label={`Remove ${title.toLowerCase()} region ${index + 1}`}
                    onClick={() => replace(key, asInput(study[key].filter((_, at) => at !== index)))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="analysis__controls">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid={`topology-${key}-selection`}
              disabled={selection.length === 0}
              onClick={() =>
                replace(key, [...asInput(study[key]), ...selection.map((entityId): TopologyRegion => ({ kind: 'entity', entityId }))])
              }
            >
              Add selected solids
            </button>
          </div>
          <BoxForm onAdd={(min, max) => replace(key, [...asInput(study[key]), { kind: 'box', min, max }])} />
        </div>
      ))}
    </PanelSection>
  );
}
