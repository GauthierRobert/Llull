/**
 * @layer ui/panels/civil
 *
 * CivilPanel — the civil / site-engineering workspace, in workflow order: 1 survey, 2 terrain,
 * 3 earthworks, 4 roads, 5 drainage, 6 exports. Every change goes through dispatch (PRIME
 * DIRECTIVE); reports and exports run read-only commands locally.
 */

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { SurveySection } from './SurveySection';
import { TerrainSection } from './TerrainSection';
import { EarthworksSection } from './EarthworksSection';
import { RoadsSection } from './RoadsSection';
import { DrainageSection } from './DrainageSection';
import { CivilExportsSection } from './CivilExportsSection';

export function CivilPanel({ className }: { className?: string }): React.ReactElement {
  const objectCount = useStore((s) => s.document.civil?.order.length ?? 0);
  return (
    <div className={classNames('panel civil-panel', className)} data-testid="civil-panel">
      <PanelHeader
        title="Civil / Site"
        count={objectCount}
        countLabel={`${objectCount} civil objects`}
      />
      {objectCount === 0 && (
        <PanelEmpty
          icon="terrain"
          message="No site data yet"
          hint="Start with the survey: 1 import points, 2 build the terrain, then grade pads, lay out roads and drainage."
          compact
        />
      )}
      <SurveySection />
      <TerrainSection />
      <EarthworksSection />
      <RoadsSection />
      <DrainageSection />
      <CivilExportsSection />
    </div>
  );
}
