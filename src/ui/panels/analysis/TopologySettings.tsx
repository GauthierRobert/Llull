// Solver settings of one study: each shows its value and where it comes from (named default or given); Apply dispatches only what changed.

import React, { useId, useState } from 'react';
import type { NamedValue, TopologyStudy } from '@core/model/topology';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';

interface NumberSetting {
  readonly key: 'penal' | 'move' | 'changeTol' | 'maxIterations' | 'greyLimit';
  readonly label: string;
}

const NUMBERS: readonly NumberSetting[] = [
  { key: 'penal', label: 'Penalisation p' },
  { key: 'move', label: 'Move limit' },
  { key: 'changeTol', label: 'Change tolerance' },
  { key: 'maxIterations', label: 'Max iterations' },
  { key: 'greyLimit', label: 'Grey limit' },
];

const sourceOf = (named: NamedValue): string => (named.defaulted ? `default: ${named.source}` : `set by ${named.source}`);

export function TopologySettings({ study }: { study: TopologyStudy }): React.ReactElement {
  const ids = useId();
  const dispatch = useStore((s) => s.dispatch);
  const { settings } = study;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [kind, setKind] = useState(settings.filter.kind);
  const shown = (key: string, named: NamedValue): string => draft[key] ?? String(named.value);

  const changes: Record<string, unknown> = {};
  for (const { key } of NUMBERS) {
    const value = Number(shown(key, settings[key]));
    if (draft[key] !== undefined && Number.isFinite(value) && value !== settings[key].value) changes[key] = value;
  }
  const radius = Number(shown('radius', settings.filter.radius));
  const radiusChanged = draft['radius'] !== undefined && Number.isFinite(radius) && radius !== settings.filter.radius.value;
  if (radiusChanged || kind !== settings.filter.kind) {
    changes['filter'] = { kind, ...(radiusChanged ? { radius } : {}) };
  }
  const dirty = Object.keys(changes).length > 0;

  const edit = (key: string, value: string): void => setDraft({ ...draft, [key]: value });
  const apply = (): void => {
    dispatch('set_topology_settings', { studyId: study.id, ...changes });
    setDraft({});
  };

  return (
    <PanelSection
      title="Settings"
      hint="Named defaults come from the cited source; changing a solver setting makes a recorded result stale."
      collapsible
    >
      <div className="analysis__controls" data-testid="topology-settings">
        {NUMBERS.map(({ key, label }) => (
          <label key={key} className="field" htmlFor={`${ids}-${key}`}>
            <span className="field__label">{label}</span>
            <input
              id={`${ids}-${key}`}
              type="number"
              step="any"
              data-testid={`topology-setting-${key}`}
              value={shown(key, settings[key])}
              onChange={(e) => edit(key, e.target.value)}
            />
            <span className="analysis__source" data-testid={`topology-source-${key}`}>
              {sourceOf(settings[key])}
            </span>
          </label>
        ))}
        <label className="field" htmlFor={`${ids}-kind`}>
          <span className="field__label">Filter</span>
          <select
            id={`${ids}-kind`}
            data-testid="topology-setting-filter-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value === 'density' ? 'density' : 'sensitivity')}
          >
            <option value="sensitivity">sensitivity</option>
            <option value="density">density</option>
          </select>
        </label>
        <label className="field" htmlFor={`${ids}-radius`}>
          <span className="field__label">Filter radius</span>
          <input
            id={`${ids}-radius`}
            type="number"
            step="any"
            data-testid="topology-setting-radius"
            value={shown('radius', settings.filter.radius)}
            onChange={(e) => edit('radius', e.target.value)}
          />
          <span className="analysis__source" data-testid="topology-source-radius">
            {sourceOf(settings.filter.radius)}
          </span>
        </label>
      </div>
      <button type="button" className="btn btn--ghost btn--sm" data-testid="topology-apply-settings" disabled={!dirty} onClick={apply}>
        Apply settings
      </button>
    </PanelSection>
  );
}
