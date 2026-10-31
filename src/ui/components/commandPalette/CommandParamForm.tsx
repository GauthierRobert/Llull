// Generated param form for one registry command (ids pre-filled from the selection); destructive commands warn and
// use a danger Run. Submit parses + dispatches; Escape / Back returns to the list.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CommandDefinition } from '@core/commands/types';
import { useStore } from '@ui/store';
import { usePreviewStore } from '@ui/store/previewStore';
import { isPreviewable } from '@ui/preview/previewable';
import { previewNote } from '@ui/preview/previewNote';
import { usePreviewController } from '@ui/preview/usePreviewController';
import { Icon } from '@ui/components/Icon';
import { commandLabel, fieldsFromSchema, initialValues, matchTypeahead, parseFormValues, valuesFromParams } from './paramForm';
import { visibleFields } from './fieldVisibility';
import type { FormField, FormValues } from './paramForm';

interface CommandParamFormProps {
  command: CommandDefinition<unknown>;
  onBack: () => void;
  onSubmit: (params: Record<string, unknown>) => void;
  /** Edit mode: pre-fill from these instead of the selection. */
  initialParams?: Readonly<Record<string, unknown>>;
  /** Default "Run". */
  submitLabel?: string;
  /** Default "Back to commands". */
  backLabel?: string;
  /** Last submit's refusal / result. */
  statusMessage?: string | null;
  /** Show a live ghost of the result in the viewport while the params are valid (never dispatches). */
  preview?: boolean;
}

const PLACEHOLDERS: Readonly<Record<FormField['kind'], string>> = {
  number: 'Number',
  text: '',
  enum: '',
  boolean: '',
  numberList: 'e.g. 0, 0, 10',
  textList: 'id-1, id-2',
  json: 'JSON',
};

interface FieldControlProps {
  field: FormField;
  id: string;
  value: string;
  describedBy: string;
  invalid: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
}

const TYPEAHEAD_RESET_MS = 700;

interface TypeaheadSelectProps {
  common: React.SelectHTMLAttributes<HTMLSelectElement>;
  value: string;
  options: readonly string[];
  optional: boolean;
  onChange: (value: string) => void;
}

/** Type-to-select prefers an exact option over the first prefix match. */
function TypeaheadSelect({ common, value, options, optional, onChange }: TypeaheadSelectProps): React.ReactElement {
  const typed = useRef({ text: '', at: 0 });
  return (
    <select
      {...common}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.key === ' ') return;
        const now = Date.now();
        const text = now - typed.current.at > TYPEAHEAD_RESET_MS ? e.key : typed.current.text + e.key;
        typed.current = { text, at: now };
        const match = matchTypeahead(options, text);
        if (match === undefined) return;
        e.preventDefault();
        onChange(match);
      }}
    >
      {optional && <option value="">Default</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function FieldControl({ field, id, value, describedBy, invalid, autoFocus, onChange }: FieldControlProps): React.ReactElement {
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid, 'aria-required': field.required, autoFocus };
  if (field.kind === 'enum' || field.kind === 'boolean') {
    const options = field.kind === 'boolean' ? ['true', 'false'] : field.options;
    return <TypeaheadSelect common={common} value={value} options={options} optional={!field.required} onChange={onChange} />;
  }
  if (field.kind === 'json') {
    return (
      <textarea
        {...common}
        rows={3}
        spellCheck={false}
        value={value}
        placeholder={field.example === '' || field.example === 'null' ? PLACEHOLDERS.json : `JSON, e.g. ${field.example}`}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      {...common}
      type="text"
      inputMode={field.kind === 'number' ? 'decimal' : undefined}
      spellCheck={false}
      autoComplete="off"
      value={value}
      placeholder={field.required ? PLACEHOLDERS[field.kind] : 'Default'}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function CommandParamForm({
  command,
  onBack,
  onSubmit,
  initialParams,
  submitLabel = 'Run',
  backLabel = 'Back to commands',
  statusMessage = null,
  preview = false,
}: CommandParamFormProps): React.ReactElement {
  const allFields = useMemo(() => fieldsFromSchema(command.paramsSchema), [command]);
  const [values, setValues] = useState<FormValues>(() =>
    initialParams === undefined
      ? initialValues(allFields, useStore.getState().document.selection)
      : valuesFromParams(allFields, initialParams),
  );
  // Only the fields that apply to the chosen operation are shown, parsed and submitted (fieldVisibility).
  const fields = useMemo(() => visibleFields(command.name, allFields, values), [command.name, allFields, values]);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const baseId = useId();
  const previewing = preview && isPreviewable(command, fields);
  const controller = usePreviewController();
  const previewOutcome = usePreviewStore((s) => s.outcome);

  // External sync: ghost follows the typed params; invalid / incomplete params clear it.
  useEffect(() => {
    if (!previewing) return;
    const parsed = parseFormValues(fields, values);
    if (parsed.ok) controller.request(command.name, parsed.params);
    else controller.cancel();
  }, [previewing, fields, values, command.name, controller]);

  const submit = (): void => {
    const result = parseFormValues(fields, values);
    if (result.ok) {
      controller.cancel();
      onSubmit(result.params);
    } else setErrors(result.errors);
  };

  const requiredCount = fields.filter((f) => f.required).length;
  const destructive = command.annotations?.destructive === true;

  return (
    <form
      className="palette-form"
      aria-label={`${commandLabel(command.name)} parameters`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <header className="palette-form__header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label={backLabel}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <div className="palette-form__heading">
          <h3 className="palette-form__title">{commandLabel(command.name)}</h3>
          <p className="palette-form__desc" title={command.description}>
            {command.description}
          </p>
        </div>
        <code className="palette-form__tool" title="Command (CLI tool) name">
          {command.name}
        </code>
      </header>

      {destructive && (
        <p className="palette-form__warning" role="note">
          <Icon name="info" size={14} />
          This command removes document content. You can undo it afterwards.
        </p>
      )}

      {fields.length > 0 && (
        <div className="palette-form__fields">
          {fields.map((field, index) => {
            const fieldId = `${baseId}-${field.name}`;
            const helpId = `${fieldId}-help`;
            const error = errors[field.name];
            return (
              <div key={field.name} className={`palette-field${error !== undefined ? ' palette-field--invalid' : ''}`}>
                <label htmlFor={fieldId} className="palette-field__label">
                  {field.label}
                  {field.required ? (
                    <span className="palette-field__req" aria-hidden="true">
                      *
                    </span>
                  ) : (
                    <span className="palette-field__opt">optional</span>
                  )}
                </label>
                <FieldControl
                  field={field}
                  id={fieldId}
                  value={values[field.name] ?? ''}
                  describedBy={helpId}
                  invalid={error !== undefined}
                  autoFocus={index === 0}
                  onChange={(value) => {
                    setValues((prev) => ({ ...prev, [field.name]: value }));
                    if (error !== undefined) {
                      setErrors(({ [field.name]: _cleared, ...rest }) => rest);
                    }
                  }}
                />
                <p id={helpId} className="palette-field__help">
                  {error !== undefined ? <strong role="alert">{error} </strong> : null}
                  {field.description}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {previewing && previewOutcome !== null && (
        <p className={`palette-form__preview${previewNote(previewOutcome).refused ? ' palette-form__preview--refused' : ''}`} role="status">
          <strong>{previewNote(previewOutcome).label}</strong> {previewNote(previewOutcome).text}
        </p>
      )}

      {statusMessage !== null && (
        <p className="palette-form__status" role="alert">
          {statusMessage}
        </p>
      )}

      <footer className="palette-form__footer">
        <span className="palette-form__meta">
          {fields.length === 0
            ? 'No parameters.'
            : requiredCount === 0
              ? 'All parameters are optional.'
              : `${requiredCount} required · blank optional fields use defaults`}
        </span>
        <button type="submit" className={`btn ${destructive ? 'btn--destructive' : 'btn--primary'}`} autoFocus={fields.length === 0}>
          {submitLabel}
          <kbd className="kbd kbd--on-accent">Ctrl ↵</kbd>
        </button>
      </footer>
    </form>
  );
}
