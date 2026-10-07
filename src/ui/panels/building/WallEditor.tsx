/**
 * @layer ui/panels/building
 * Wall inspector editor: Save dispatches ONE `update_wall` with the changed thickness / height /
 * material.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { WallElement } from '@core/model/building';

export function WallEditor({ wall }: { wall: WallElement }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [thickness, setThickness] = useState(String(wall.thickness));
  const [height, setHeight] = useState(String(wall.height));
  const [material, setMaterial] = useState(wall.material);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const changes: Record<string, unknown> = {};
    if (thickness !== String(wall.thickness) && Number.isFinite(Number(thickness))) {
      changes['thickness'] = Number(thickness);
    }
    if (height !== String(wall.height) && Number.isFinite(Number(height))) {
      changes['height'] = Number(height);
    }
    if (material.trim() !== '' && material !== wall.material) changes['material'] = material.trim();
    if (Object.keys(changes).length > 0) dispatch('update_wall', { wallId: wall.id, ...changes });
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Wall ${wall.mark} properties`}
      data-testid="wall-editor"
    >
      <label className="field">
        <span className="field__label">Thickness</span>
        <input type="number" value={thickness} onChange={(e) => setThickness(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Height</span>
        <input type="number" value={height} onChange={(e) => setHeight(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Material</span>
        <input type="text" value={material} onChange={(e) => setMaterial(e.target.value)} />
      </label>
      <button type="submit" className="btn btn--primary btn--sm" data-testid="wall-save">
        Save wall
      </button>
    </form>
  );
}
