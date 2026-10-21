// Wall editor: Save dispatches ONE `update_wall` with the changed thickness / height / material.

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { WallElement } from '@aec/building/types';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { changedNumber, changedText } from '@ui/panels/changedParams';

export function WallEditor({ wall }: { wall: WallElement }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [thickness, setThickness] = useState(String(wall.thickness));
  const [height, setHeight] = useState(String(wall.height));
  const [material, setMaterial] = useState(wall.material);

  const handleSubmit = (): void => {
    const changes = {
      ...changedNumber('thickness', thickness, wall.thickness),
      ...changedNumber('height', height, wall.height),
      ...changedText('material', material, wall.material),
    };
    if (Object.keys(changes).length > 0) dispatch('update_wall', { wallId: wall.id, ...changes });
  };

  return (
    <CommandForm
      ariaLabel={`Wall ${wall.mark} properties`}
      testId="wall-editor"
      submitLabel="Save wall"
      submitTestId="wall-save"
      onSubmit={handleSubmit}
    >
      <LabeledInput label="Thickness" type="number" value={thickness} onChange={setThickness} />
      <LabeledInput label="Height" type="number" value={height} onChange={setHeight} />
      <LabeledInput label="Material" type="text" value={material} onChange={setMaterial} />
    </CommandForm>
  );
}
