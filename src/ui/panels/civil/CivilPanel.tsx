// Civil / site workspace in workflow order: 1 survey, 2 terrain, 3 earthworks, 4 roads, 5 drainage, then exports. A step with objects is
// ticked and starts expanded (its list is what an engineer reviews); so does the next step to do. The rest start collapsed.

import React from 'react';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { PanelEmpty, PanelHeader } from '@ui/panels/PanelParts';
import { SurveySection } from './SurveySection';
import { CivilCrsSection } from './CivilCrsSection';
import { TerrainSection } from './TerrainSection';
import { EarthworksSection } from './EarthworksSection';
import { RoadsSection } from './RoadsSection';
import { DrainageSection } from './DrainageSection';
import { CivilExportsSection } from './CivilExportsSection';
import { CivilFeedback } from './CivilFeedback';
import { civilStepStates } from './civilSteps';

export function CivilPanel({ className }: { className?: string }): React.ReactElement {
  const civil = useStore((s) => s.document.civil);
  const objectCount = civil?.order.length ?? 0;
  const steps = civilStepStates(civil);
  return (
    <div className={classNames('panel civil-panel', className)} data-testid="civil-panel">
      <PanelHeader title="Civil / Site" count={objectCount} countLabel={`${objectCount} civil objects`}>
        <CivilFeedback />
      </PanelHeader>
      {objectCount === 0 && (
        <PanelEmpty
          icon="terrain"
          message="No site data yet"
          hint="Start with the survey: 1 import points, 2 build the terrain, then grade pads, lay out roads and drainage."
          compact
        />
      )}
      <SurveySection {...steps.survey} />
      <CivilCrsSection defaultOpen={civil?.crs !== undefined} />
      <TerrainSection {...steps.terrain} />
      <EarthworksSection {...steps.earthworks} />
      <RoadsSection {...steps.roads} />
      <DrainageSection {...steps.drainage} />
      <CivilExportsSection defaultOpen={steps.terrain.done} />
    </div>
  );
}
