// Pick a PNG/JPEG (scanned drawing) → `add_image_underlay` as a data URL; calibration / tracing are commands.

import React, { useRef } from 'react';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { readAsDataUrl, takeChosenFile } from '@ui/chosenFile';

/** The data URL is embedded in the document and autosaved to localStorage (~5 MB quota). */
export const MAX_UNDERLAY_DATA_URL_CHARS = 2_000_000;

export function ImageUnderlayImport(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = takeChosenFile(e);
    if (!file) return;
    const { setStatusMessage } = useStore.getState();
    void readAsDataUrl(file).then(
      (dataUrl) => {
        if (dataUrl.length > MAX_UNDERLAY_DATA_URL_CHARS) {
          setStatusMessage(`${file.name} is too large for an underlay (over 2 MB). Downscale or compress it first.`);
          return;
        }
        dispatch('add_image_underlay', { dataUrl, name: file.name, locked: true });
      },
      (error: unknown) => {
        console.error(error);
        setStatusMessage(`Could not read ${file.name}.`);
      },
    );
  };

  return (
    <>
      <button
        type="button"
        className="project-io__btn"
        onClick={() => fileInputRef.current?.click()}
        aria-label="Add an image underlay to trace over (PNG or JPEG)"
        title="Image underlay (.png, .jpg) — then calibrate_underlay"
      >
        <Icon name="image" size={14} />
        <span>Underlay</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        onChange={handleFileChange}
        style={{ display: 'none' }}
        aria-label="Image underlay file"
      />
    </>
  );
}
