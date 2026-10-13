import type React from 'react';
import { useStore } from '@ui/store';

/** Clears the input so re-picking the same file fires again. */
export function takeChosenFile(event: React.ChangeEvent<HTMLInputElement>): File | undefined {
  const file = event.target.files?.[0];
  event.target.value = '';
  return file;
}

/** "site.dxf" -> "site". */
export function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Clears the input like `takeChosenFile`. */
export function readChosenFile(event: React.ChangeEvent<HTMLInputElement>, onText: (text: string, fileName: string) => void): void {
  const file = takeChosenFile(event);
  if (!file) return;
  file
    .text()
    .then((text) => onText(text, file.name))
    .catch(() => useStore.getState().setStatusMessage(`Could not read ${file.name}.`));
}

/** Images embedded in the document. */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`cannot read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
