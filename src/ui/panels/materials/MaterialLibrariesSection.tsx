// Imported material libraries (08 §7): title, version, licence and export-marking badges, the records each one supplies. Selecting a
// record opens it in the inspector. Read-only: import / remove stay commands (import_material_library, remove_material_library).

import React from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { isControlled, licenceText, markingText } from './materialRecordView';

export function MaterialLibrariesSection({ onSelect }: { onSelect: (materialName: string) => void }): React.ReactElement | null {
  const libraries = useStore((s) => s.document.materialLibraries);
  const materials = useStore((s) => s.document.materials);
  const entries = Object.values(libraries ?? {});
  if (entries.length === 0) return null;
  return (
    <PanelSection title="Libraries" count={entries.length} testId="material-libraries">
      <ul className="panel__list" aria-label="Material libraries">
        {entries.map((library) => {
          const records = Object.values(materials).filter((m) => m.record?.libraryRef?.libraryId === library.libraryId);
          return (
            <li key={library.libraryId} className="panel__row material-library" data-testid={`library-${library.libraryId}`}>
              <div className="material-library__head">
                <strong>{library.title}</strong>
                <span className="panel__row-meta">v{library.version}</span>
              </div>
              <div className="material-library__badges">
                <span className="badge" data-testid={`library-licence-${library.libraryId}`}>
                  {licenceText(library.licence)}
                </span>
                <span
                  className={`badge${isControlled(library.exportMarking) ? ' badge--danger' : ''}`}
                  data-testid={`library-marking-${library.libraryId}`}
                >
                  {markingText(library.exportMarking)}
                </span>
                {library.storage === 'private' && <span className="badge">Private storage</span>}
              </div>
              <ul className="material-library__records" aria-label={`${library.title} records`}>
                {records.map((material) => (
                  <li key={material.name}>
                    <button
                      type="button"
                      className="material-row-btn"
                      onClick={() => onSelect(material.name)}
                      data-testid={`record-${material.name}`}
                    >
                      <span className="material-name">{material.record?.designation ?? material.name}</span>
                      <span className="panel__row-meta">{material.record?.temper ?? ''}</span>
                      {material.record?.unresolved !== undefined && <span className="finding__badge">unresolved</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </PanelSection>
  );
}
