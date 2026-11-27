// Read-only readout of the appearance channels that apply to an entity (entity override over its material's). Editing is
// `set_material_appearance` / `apply_appearance`, reached from the command palette.

import React from 'react';
import type { Appearance } from '@core/model/appearance';
import { useStore } from '@ui/store';
import { PropRow } from '../propertyFields';
import { resolveAppearance } from '@ui/viewport/3d/appearance/surfacePlan';
import type { Entity } from '@core/model/types';

/** One line per set channel: value, texture name, or both. */
function channelSummaries(appearance: Appearance, textureName: (id: string) => string): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  const channel = (label: string, value: string | number | undefined, texture: string | undefined): void => {
    if (value === undefined && texture === undefined) return;
    const parts = [value === undefined ? undefined : String(value), texture === undefined ? undefined : textureName(texture)];
    rows.push([label, parts.filter((part) => part !== undefined).join(' × ')]);
  };
  channel('Base colour', appearance.baseColor?.value, appearance.baseColor?.texture);
  channel('Metalness', appearance.metalness?.value, appearance.metalness?.texture);
  channel('Roughness', appearance.roughness?.value, appearance.roughness?.texture);
  channel('Normal map', undefined, appearance.normal?.texture);
  channel('Emission', appearance.emission?.value, appearance.emission?.texture);
  channel('Transmission', appearance.transmission?.value, appearance.transmission?.texture);
  channel('IOR', appearance.ior, undefined);
  channel('Coat', appearance.coat?.value, appearance.coat?.texture);
  return rows;
}

export function AppearanceRows({ entity }: { entity: Entity }): React.ReactElement | null {
  const material = useStore((s) => (entity.materialId === undefined ? undefined : s.document.materials[entity.materialId]));
  const textures = useStore((s) => s.document.appearance?.textures);
  const appearance = resolveAppearance(entity, material);
  if (appearance === undefined) return null;
  const rows = channelSummaries(appearance, (id) => textures?.[id]?.name ?? 'missing texture');
  return (
    <>
      {rows.map(([label, value]) => (
        <PropRow key={label} label={label}>
          <span className="props-number">{value}</span>
        </PropRow>
      ))}
    </>
  );
}
