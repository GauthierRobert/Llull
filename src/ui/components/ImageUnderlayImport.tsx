// Pick a PNG/JPEG (scanned drawing) → `add_image_underlay` as a data URL; calibration / tracing are commands.

import React, { useRef } from 'react';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { readAsDataUrl, takeChosenFile } from '@ui/chosenFile';

export function ImageUnderlayImport(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = takeChosenFile(e);
    if (!file) return;
    void readAsDataUrl(file).then(
      (dataUrl) => dispatch('add_image_underlay', { dataUrl, name: file.name, locked: true }),
      (error: unknown) => console.error(error),
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
