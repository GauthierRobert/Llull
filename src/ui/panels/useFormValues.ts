// Controlled panel form state: field values + one inline error cleared on every edit.

import { useState } from 'react';

interface FormValues<V extends Readonly<Record<string, string>>> {
  values: V;
  error: string;
  setError: (message: string) => void;
  change: (key: keyof V & string, value: string) => void;
  /** `{ value, set }` of one field, ready to spread on a text / number field. */
  field: (key: keyof V & string) => { value: string; set: (value: string) => void };
}

export function useFormValues<V extends Readonly<Record<string, string>>>(initial: () => V): FormValues<V> {
  const [values, setValues] = useState<V>(initial);
  const [error, setError] = useState('');
  const change = (key: keyof V & string, value: string): void => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setError('');
  };
  const field = (key: keyof V & string): { value: string; set: (value: string) => void } => ({
    value: values[key] ?? '',
    set: (value) => change(key, value),
  });
  return { values, error, setError, change, field };
}
