/**
 * @layer ui/panels/building
 * Controlled form state shared by the building forms: field values, one inline error that clears
 * on every edit.
 */

import { useState } from 'react';

interface FormValues<V extends Readonly<Record<string, string>>> {
  values: V;
  error: string;
  setError: (message: string) => void;
  change: (key: keyof V & string, value: string) => void;
}

export function useFormValues<V extends Readonly<Record<string, string>>>(
  initial: () => V,
): FormValues<V> {
  const [values, setValues] = useState<V>(initial);
  const [error, setError] = useState('');
  const change = (key: keyof V & string, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setError('');
  };
  return { values, error, setError, change };
}
