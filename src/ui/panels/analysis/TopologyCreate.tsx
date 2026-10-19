// New topology study: gathers the design domain (the selected solids), voxel, volume fraction and dimension / plane, then dispatches
// create_topology_study. The command validates and fills the named defaults.

import React, { useId, useState } from 'react';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';

const PLANES = ['XY', 'XZ', 'YZ'] as const;

export function TopologyCreate({ analysisId }: { analysisId: string }): React.ReactElement {
  const ids = useId();
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.document.selection);
  const [name, setName] = useState('');
  const [voxel, setVoxel] = useState('');
  const [volumeFraction, setVolumeFraction] = useState('0.5');
  const [dimension, setDimension] = useState<2 | 3>(3);
  const [plane, setPlane] = useState<(typeof PLANES)[number]>('XY');

  const voxelValue = Number(voxel);
  const fractionValue = Number(volumeFraction);
  const reason =
    selection.length === 0
      ? 'Select the solids that may be reshaped.'
      : !(voxel !== '' && voxelValue > 0)
        ? 'Enter a voxel size above 0.'
        : !(fractionValue > 0 && fractionValue < 1)
          ? 'Volume fraction must be between 0 and 1.'
          : null;

  const create = (): void => {
    dispatch('create_topology_study', {
      analysisId,
      name: name.trim() === '' ? 'Topology study' : name.trim(),
      designDomain: [...selection],
      dimension,
      ...(dimension === 2 ? { plane } : {}),
      voxel: voxelValue,
      volumeFraction: fractionValue,
    });
  };

  return (
    <PanelSection title="New study" hint="Reshape the selected solids to the stiffest layout that keeps the volume fraction.">
      <div className="analysis__controls">
        <label className="field" htmlFor={`${ids}-name`}>
          <span className="field__label">Name</span>
          <input
            id={`${ids}-name`}
            data-testid="topology-name"
            value={name}
            placeholder="30 % lighter"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${ids}-voxel`}>
          <span className="field__label">Voxel</span>
          <input
            id={`${ids}-voxel`}
            type="number"
            min={0}
            step="any"
            data-testid="topology-voxel"
            value={voxel}
            placeholder="grid spacing"
            onChange={(e) => setVoxel(e.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${ids}-fraction`}>
          <span className="field__label">Volume fraction</span>
          <input
            id={`${ids}-fraction`}
            type="number"
            min={0}
            max={1}
            step={0.05}
            data-testid="topology-fraction"
            value={volumeFraction}
            onChange={(e) => setVolumeFraction(e.target.value)}
          />
        </label>
        <label className="field" htmlFor={`${ids}-dim`}>
          <span className="field__label">Dimension</span>
          <select
            id={`${ids}-dim`}
            data-testid="topology-dimension"
            value={dimension}
            onChange={(e) => setDimension(e.target.value === '2' ? 2 : 3)}
          >
            <option value={3}>3D solid</option>
            <option value={2}>2D plane stress</option>
          </select>
        </label>
        {dimension === 2 && (
          <label className="field" htmlFor={`${ids}-plane`}>
            <span className="field__label">Plane</span>
            <select
              id={`${ids}-plane`}
              data-testid="topology-plane"
              value={plane}
              onChange={(e) => setPlane(PLANES.find((candidate) => candidate === e.target.value) ?? 'XY')}
            >
              {PLANES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="analysis__line" data-testid="topology-domain">
        Design domain: {selection.length === 0 ? 'nothing selected' : selection.join(', ')}
      </p>
      {reason !== null && <p className="analysis__hint">{reason}</p>}
      <button type="button" className="btn btn--primary btn--sm" data-testid="topology-create" disabled={reason !== null} onClick={create}>
        Create study
      </button>
    </PanelSection>
  );
}
