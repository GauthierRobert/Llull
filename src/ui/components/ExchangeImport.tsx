// Pick a STEP / IGES file: "Import" dispatches `import_step_exact` / `import_iges` (the report and the validation badge show in the properties panel),
// "Verify" dispatches the read-only `verify_exchange_file` (its report card appears over the viewport). Both are commands; this only gathers the file.

import React, { useRef } from 'react';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { readChosenFile } from '@ui/chosenFile';
import { sha256Hex } from '@lib/sha256';

const IGES_FILE = /\.(igs|iges)$/i;
const ACCEPT = '.stp,.step,.p21,.igs,.iges';

export function ExchangeImport(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const importInput = useRef<HTMLInputElement | null>(null);
  const verifyInput = useRef<HTMLInputElement | null>(null);

  const onImport = (event: React.ChangeEvent<HTMLInputElement>): void =>
    readChosenFile(event, (text, fileName) => {
      const common = { text, fileName, sha256: sha256Hex(text) };
      dispatch(IGES_FILE.test(fileName) ? 'import_iges' : 'import_step_exact', common, { selectAffected: true });
    });
  const onVerify = (event: React.ChangeEvent<HTMLInputElement>): void =>
    readChosenFile(event, (text, fileName) => dispatch('verify_exchange_file', { text, fileName }));

  return (
    <>
      <button
        type="button"
        className="project-io__btn"
        onClick={() => importInput.current?.click()}
        aria-label="Import a STEP or IGES file as exact solids"
        title="Import STEP / IGES (exact B-rep, assembly structure, validation-property check)"
      >
        <Icon name="cube" size={14} />
        <span>Import STEP/IGES</span>
      </button>
      <input
        ref={importInput}
        type="file"
        accept={ACCEPT}
        onChange={onImport}
        style={{ display: 'none' }}
        aria-label="STEP or IGES file to import"
      />
      <button
        type="button"
        className="project-io__btn"
        onClick={() => verifyInput.current?.click()}
        aria-label="Verify a STEP or IGES file without importing it"
        title="Verify a file: schema, unit, census, validation properties (nothing is imported)"
      >
        <Icon name="ruler" size={14} />
        <span>Verify file</span>
      </button>
      <input
        ref={verifyInput}
        type="file"
        accept={ACCEPT}
        onChange={onVerify}
        style={{ display: 'none' }}
        aria-label="STEP or IGES file to verify"
      />
    </>
  );
}
