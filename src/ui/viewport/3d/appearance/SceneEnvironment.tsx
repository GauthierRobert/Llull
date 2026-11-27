// `doc.appearance.environment` in the viewport (RV-M2): 'color' = background + ambient tint, 'sky' = the Preetham sky (SiteSky reads the
// turbidity), 'hdr' = image-based light and background (HdrEnvironment, which falls back to the default environment while loading or on
// failure). Absent = today's look.

import { useStore } from '@ui/store';
import { HdrEnvironment, useHdrEnvironment } from './HdrEnvironment';
import { environmentLook, type EnvironmentLook } from './environmentPlan';

export function useEnvironmentLook(paletteBackground: string): { look: EnvironmentLook; hdr: boolean } {
  const environment = useStore((s) => s.document.appearance?.environment);
  const hdr = useHdrEnvironment() !== null;
  return { look: environmentLook(environment, paletteBackground), hdr };
}

export function SceneEnvironment({ look, hdrBackground }: { look: EnvironmentLook; hdrBackground: boolean }): React.ReactElement {
  return (
    <>
      {look.ambient !== null && <ambientLight color={look.ambient.color} intensity={look.ambient.intensity} />}
      <HdrEnvironment background={hdrBackground} />
    </>
  );
}
