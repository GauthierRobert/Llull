import type React from 'react';

/**
 * The first file chosen in a file input, if any. Clears the input so picking the same file again
 * fires another change event.
 */
export function takeChosenFile(event: React.ChangeEvent<HTMLInputElement>): File | undefined {
  const file = event.target.files?.[0];
  event.target.value = '';
  return file;
}

/** `fileName` without its last extension ("site.dxf" -> "site"). */
export function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Reads the first chosen file as text, then hands it to `onText` (clears the input like `takeChosenFile`). */
export function readChosenFile(event: React.ChangeEvent<HTMLInputElement>, onText: (text: string, fileName: string) => void): void {
  const file = takeChosenFile(event);
  if (!file) return;
  file
    .text()
    .then((text) => onText(text, file.name))
    .catch(() => undefined);
}

/** Reads a file as a `data:` URL (images embedded in the document). */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`cannot read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
