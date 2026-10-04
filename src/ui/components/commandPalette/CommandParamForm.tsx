/**
 * @layer ui/components/commandPalette
 *
 * Generated param form for one registry command: one control per `paramsSchema` property,
 * entity-id fields pre-filled from the selection; a destructive command shows a warning and a
 * danger-styled Run. Submitting parses the text and dispatches the
 * command (react R1: gather params -> dispatch). Escape / Back returns to the command list.
 */

import React, { useId, useMemo, useState } from 'react';
import type { CommandDefinition } from '@core/commands/types';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { fieldsFromSchema, humanizeName, initialValues, parseFormValues } from './paramForm';
import type { FormField, FormValues } from './paramForm';

interface CommandParamFormProps {
  command: CommandDefinition<unknown>;
  onBack: () => void;
  onSubmit: (params: Record<string, unknown>) => void;
}

const PLACEHOLDERS: Readonly<Record<FormField['kind'], string>> = {
  number: 'Number',
  text: '',
  enum: '',
  boolean: '',
  numberList: 'e.g. 0, 0, 10',
  textList: 'id-1, id-2',
  json: 'JSON, e.g. [[0,0],[10,0]]',
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

function FieldControl({
  field,
  id,
  value,
  describedBy,
  invalid,
  autoFocus,
  onChange,
}: FieldControlProps): React.ReactElement {
  const common = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    'aria-required': field.required,
    autoFocus,
  };
  if (field.kind === 'enum' || field.kind === 'boolean') {
    const options = field.kind === 'boolean' ? ['true', 'false'] : field.options;
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        {!field.required && <option value="">Default</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'json') {
    return (
      <textarea
        {...common}
        rows={3}
        spellCheck={false}
        value={value}
        placeholder={PLACEHOLDERS.json}
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
}: CommandParamFormProps): React.ReactElement {
  const fields = useMemo(() => fieldsFromSchema(command.paramsSchema), [command]);
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(fields, useStore.getState().document.selection),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const baseId = useId();

  const submit = (): void => {
    const result = parseFormValues(fields, values);
    if (result.ok) onSubmit(result.params);
    else setErrors(result.errors);
  };

  const requiredCount = fields.filter((f) => f.required).length;
  const destructive = command.annotations?.destructive === true;

  return (
    <form
      className="palette-form"
      aria-label={`${humanizeName(command.name)} parameters`}
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
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to commands">
          <Icon name="arrowLeft" size={14} />
        </button>
        <div className="palette-form__heading">
          <h3 className="palette-form__title">{humanizeName(command.name)}</h3>
          <p className="palette-form__desc" title={command.description}>
            {command.description}
          </p>
        </div>
        <code className="palette-form__tool" title="MCP tool name">
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
              <div
                key={field.name}
                className={`palette-field${error !== undefined ? ' palette-field--invalid' : ''}`}
              >
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

      <footer className="palette-form__footer">
        <span className="palette-form__meta">
          {fields.length === 0
            ? 'No parameters.'
            : requiredCount === 0
              ? 'All parameters are optional.'
              : `${requiredCount} required · blank optional fields use defaults`}
        </span>
        <button
          type="submit"
          className={`btn ${destructive ? 'btn--destructive' : 'btn--primary'}`}
          autoFocus={fields.length === 0}
        >
          Run
          <kbd className="kbd kbd--on-accent">Ctrl ↵</kbd>
        </button>
      </footer>
    </form>
  );
}
