/**
 * @layer ui/panels/building
 *
 * ProjectSection — title-block / IFC project metadata form → `set_project_info` (also on an
 * empty document: the command creates the building model).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { createEmptyBuilding, type ProjectInfo } from '@core/model/building';
import { PanelSection } from '@ui/panels/PanelParts';

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

interface ProjectFormProps {
  project: ProjectInfo;
}

function ProjectForm({ project }: ProjectFormProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [values, setValues] = useState<ProjectInfo>(project);
  const changed = FIELDS.some(([key]) => values[key] !== project[key]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const changes = Object.fromEntries(
      FIELDS.filter(([key]) => values[key] !== project[key]).map(([key]) => [key, values[key]]),
    );
    dispatch('set_project_info', changes);
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label="Project information"
    >
      {FIELDS.map(([key, label]) => (
        <label key={key} className="field">
          <span className="field__label">{label}</span>
          <input
            type="text"
            value={values[key]}
            onChange={(event) =>
              setValues((previous) => ({ ...previous, [key]: event.target.value }))
            }
            data-testid={`project-${key}`}
          />
        </label>
      ))}
      <button type="submit" className="btn btn--ghost btn--sm" disabled={!changed}>
        Save project info
      </button>
    </form>
  );
}

export function ProjectSection(): React.ReactElement {
  const project = useStore((s) => s.document.building?.project) ?? NEW_PROJECT;
  // Remount the form when the stored project changes (load / undo / MCP edit).
  return (
    <PanelSection title="Project" collapsible testId="building-project">
      <ProjectForm key={JSON.stringify(project)} project={project} />
    </PanelSection>
  );
}
