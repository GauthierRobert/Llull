// Title-block / IFC project form → `set_project_info` (creates the building model on an empty document).

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { createEmptyBuilding, type ProjectInfo } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { changedFields } from '@ui/panels/changedParams';
import { contentKey } from '@ui/contentKey';

const FIELDS: ReadonlyArray<readonly [keyof ProjectInfo, string]> = [
  ['name', 'Project'],
  ['client', 'Client'],
  ['address', 'Address'],
  ['author', 'Drawn by'],
  ['drawingNumber', 'Drawing no'],
  ['revision', 'Revision'],
  ['date', 'Date'],
];

/** Shown (and submitted as a diff) while the document has no building model yet. */
const NEW_PROJECT: ProjectInfo = createEmptyBuilding().project;

function ProjectForm({ project }: { project: ProjectInfo }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [values, setValues] = useState<ProjectInfo>(project);
  const changes = changedFields(
    project,
    values,
    FIELDS.map(([key]) => key),
  );
  const changed = Object.keys(changes).length > 0;

  return (
    <CommandForm
      ariaLabel="Project information"
      submitLabel="Save project info"
      ghostSubmit
      submitDisabled={!changed}
      onSubmit={() => dispatch('set_project_info', changes)}
    >
      {FIELDS.map(([key, label]) => (
        <LabeledInput
          key={key}
          label={label}
          type="text"
          value={values[key]}
          onChange={(value) => setValues((previous) => ({ ...previous, [key]: value }))}
          testId={`project-${key}`}
        />
      ))}
    </CommandForm>
  );
}

export function ProjectSection(): React.ReactElement {
  const project = useStore((s) => s.document.building?.project) ?? NEW_PROJECT;
  // Remount the form when the stored project changes (load / undo / MCP edit).
  return (
    <PanelSection title="Project" collapsible testId="building-project">
      <ProjectForm key={contentKey(project)} project={project} />
    </PanelSection>
  );
}
