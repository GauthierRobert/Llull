/**
 * @layer ui/panels/building
 * Wall inspector editor: Save dispatches ONE `update_wall` with the changed thickness / height /
 * material.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { WallElement } from '@core/model/building';
import { changedNumber, LabeledInput } from './LabeledInput';

export function WallEditor({ wall }: { wall: WallElement }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [thickness, setThickness] = useState(String(wall.thickness));
  const [height, setHeight] = useState(String(wall.height));
  const [material, setMaterial] = useState(wall.material);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const changes: Record<string, unknown> = {
      ...changedNumber('thickness', thickness, wall.thickness),
      ...changedNumber('height', height, wall.height),
    };
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
      <LabeledInput label="Thickness" type="number" value={thickness} onChange={setThickness} />
      <LabeledInput label="Height" type="number" value={height} onChange={setHeight} />
      <LabeledInput label="Material" type="text" value={material} onChange={setMaterial} />
      <button type="submit" className="btn btn--primary btn--sm" data-testid="wall-save">
        Save wall
      </button>
    </form>
  );
}
