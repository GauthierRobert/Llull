/**
 * @layer ui/panels
 *
 * ParamForm — renders an accessible form derived from a command's `paramsSchema`.
 *
 * Mapping rules (paramsSchema → DOM input type → typed JS value):
 *   number  → <input type="number">          → parseFloat(value)
 *   string  → <input type="text">            → string
 *   boolean → <input type="checkbox">        → checked boolean
 *   array   → <input type="text">            → comma/space-separated tokens → number[]
 *
 * Required fields are marked with an asterisk in the label.
 * On submit the gathered Record<string, unknown> is passed to `onSubmit`.
 * Bad/missing required fields prevent submission and show inline errors.
 */

import React, { useId, useState, useCallback } from 'react';
import type { ParamsSchema, ParamSpec } from '@core/commands/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParamFormProps {
  schema: ParamsSchema;
  /** Called with the fully parsed params object when the form is submitted. */
  onSubmit: (params: Record<string, unknown>) => void;
  /** Optional label for the submit button (default: "Run"). */
  submitLabel?: string;
}

// ---------------------------------------------------------------------------
// Per-field state shape
// ---------------------------------------------------------------------------

type FieldValue = string; // all inputs are held as raw strings; parsed on submit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLabel(key: string): string {
  return key
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parse a raw string to the typed value declared by `spec`. */
function parseValue(raw: string, spec: ParamSpec): unknown {
  switch (spec.type) {
    case 'number':
      return parseFloat(raw);
    case 'boolean':
      return raw === 'true';
    case 'array': {
      const tokens = raw
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      return tokens.map((t) => parseFloat(t));
    }
    default:
      return raw;
  }
}

/** Validate a parsed value; returns an error message or null. */
function validate(raw: string, key: string, spec: ParamSpec, required: boolean): string | null {
  if (raw.trim() === '') {
    return required ? `${toLabel(key)} is required.` : null;
  }
  if (spec.type === 'number') {
    if (isNaN(parseFloat(raw))) return `${toLabel(key)} must be a number.`;
  }
  if (spec.type === 'array') {
    const tokens = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.some((t) => isNaN(parseFloat(t)))) {
      return `${toLabel(key)}: all values must be numbers (e.g. 2,2,2).`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ParamForm({
  schema,
  onSubmit,
  submitLabel = 'Run',
}: ParamFormProps): React.ReactElement {
  const uid = useId();

  const properties = schema.properties;
  const requiredSet = new Set(schema.required);
  const keys = Object.keys(properties);

  // Field raw-string state
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const key of keys) {
      init[key] = '';
    }
    return init;
  });

  // Per-field error messages (set on submit attempt)
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Reset when schema changes (different command selected)
  const schemaKey = keys.join(',');
  const [lastSchemaKey, setLastSchemaKey] = useState(schemaKey);
  if (schemaKey !== lastSchemaKey) {
    const init: Record<string, FieldValue> = {};
    for (const key of keys) init[key] = '';
    setValues(init);
    setErrors({});
    setLastSchemaKey(schemaKey);
  }

  const handleChange = useCallback(
    (key: string, raw: string) => {
      setValues((prev) => ({ ...prev, [key]: raw }));
      // Clear error on change
      setErrors((prev) => ({ ...prev, [key]: null }));
    },
    [],
  );

  const handleCheckboxChange = useCallback(
    (key: string, checked: boolean) => {
      setValues((prev) => ({ ...prev, [key]: checked ? 'true' : 'false' }));
      setErrors((prev) => ({ ...prev, [key]: null }));
    },
    [],
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();

    // Validate all fields
    const newErrors: Record<string, string | null> = {};
    let hasError = false;
    for (const key of keys) {
      const spec = properties[key];
      if (!spec) continue;
      const raw = values[key] ?? '';
      const err = validate(raw, key, spec, requiredSet.has(key));
      newErrors[key] = err;
      if (err !== null) hasError = true;
    }
    setErrors(newErrors);
    if (hasError) return;

    // Parse all fields
    const params: Record<string, unknown> = {};
    for (const key of keys) {
      const spec = properties[key];
      if (!spec) continue;
      const raw = values[key] ?? '';
      if (raw.trim() === '' && !requiredSet.has(key)) continue; // skip optional empties
      params[key] = parseValue(raw, spec);
    }

    onSubmit(params);

    // Reset form after successful submit
    const reset: Record<string, FieldValue> = {};
    for (const key of keys) reset[key] = '';
    setValues(reset);
    setErrors({});
  }

  return (
    <form className="param-form" onSubmit={handleSubmit} noValidate>
      {keys.map((key) => {
        const spec = properties[key];
        if (!spec) return null;
        const inputId = `${uid}-${key}`;
        const errorId = `${uid}-${key}-error`;
        const isRequired = requiredSet.has(key);
        const rawValue = values[key] ?? '';
        const error = errors[key] ?? null;

        return (
          <div key={key} className="param-field">
            <label htmlFor={inputId} className="param-label">
              {toLabel(key)}
              {isRequired && <span className="param-required" aria-hidden="true"> *</span>}
            </label>

            {spec.type === 'boolean' ? (
              <input
                id={inputId}
                type="checkbox"
                className="param-checkbox"
                checked={rawValue === 'true'}
                onChange={(e) => handleCheckboxChange(key, e.target.checked)}
                aria-describedby={error ? errorId : undefined}
              />
            ) : spec.type === 'number' ? (
              <input
                id={inputId}
                type="number"
                className="param-input"
                value={rawValue}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={spec.description}
                required={isRequired}
                aria-required={isRequired}
                aria-describedby={error ? errorId : undefined}
                step="any"
              />
            ) : (
              /* string and array both use text input */
              <input
                id={inputId}
                type="text"
                className="param-input"
                value={rawValue}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={
                  spec.type === 'array' ? `${spec.description} (e.g. 2,2,2)` : spec.description
                }
                required={isRequired}
                aria-required={isRequired}
                aria-describedby={error ? errorId : undefined}
              />
            )}

            {error !== null && (
              <span id={errorId} className="param-error" role="alert">
                {error}
              </span>
            )}
          </div>
        );
      })}

      <button type="submit" className="param-submit">
        {submitLabel}
      </button>
    </form>
  );
}
