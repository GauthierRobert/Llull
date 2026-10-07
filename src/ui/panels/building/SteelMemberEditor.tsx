/**
 * @layer ui/panels/building
 * Steel member inspector editor: Save dispatches ONE `update_steel_member` with the changed fields.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import type { SteelMemberElement } from '@core/model/building';
import {
  buildSteelMemberUpdate,
  isHorizontalMember,
  steelMemberValues,
  type SteelMemberEditKey,
  type SteelMemberEditValues,
} from './steelMemberEdit';
import {
  ALL_PROFILES,
  BASE_OPTIONS,
  JOINT_OPTIONS,
  MEMBER_ROLE_OPTIONS,
  type SelectOption,
} from './steelProfileOptions';

interface SelectFieldProps {
  label: string;
  value: string;
  options: ReadonlyArray<SelectOption>;
  blankLabel?: string;
  onChange: (value: string) => void;
}

function SelectField({
  label,
  value,
  options,
  blankLabel,
  onChange,
}: SelectFieldProps): React.ReactElement {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {blankLabel !== undefined && <option value="">{blankLabel}</option>}
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: Omit<SelectFieldProps, 'options' | 'blankLabel'>): React.ReactElement {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function SteelMemberEditor({ member }: { member: SteelMemberElement }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const initial = steelMemberValues(member);
  const [values, setValues] = useState<SteelMemberEditValues>(initial);
  const horizontal = isHorizontalMember(member);
  const [keepTopOfSteel, setKeepTopOfSteel] = useState(true);
  const set =
    (key: SteelMemberEditKey) =>
    (value: string): void =>
      setValues((previous) => ({ ...previous, [key]: value }));

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const params = buildSteelMemberUpdate(member.id, initial, values, horizontal && keepTopOfSteel);
    if (params !== null) dispatch('update_steel_member', params);
  };

  return (
    <form
      className="panel__form building-form"
      onSubmit={handleSubmit}
      aria-label={`Steel member ${member.mark} properties`}
      data-testid="steel-member-editor"
    >
      <SelectField
        label="Profile"
        value={values.profile}
        options={ALL_PROFILES}
        onChange={set('profile')}
      />
      {horizontal && values.profile !== initial.profile && (
        <label className="field">
          <input
            type="checkbox"
            checked={keepTopOfSteel}
            onChange={(event) => setKeepTopOfSteel(event.target.checked)}
            data-testid="member-keep-top"
          />
          <span className="field__label">Keep top of steel (move the axis)</span>
        </label>
      )}
      <TextField label="Grade" value={values.material} onChange={set('material')} />
      <SelectField
        label="Role"
        value={values.role}
        options={MEMBER_ROLE_OPTIONS}
        onChange={set('role')}
      />
      {values.role === 'beam' && (
        <>
          <SelectField
            label="Start joint"
            value={values.startJoint}
            options={JOINT_OPTIONS}
            blankLabel="Default (pinned)"
            onChange={set('startJoint')}
          />
          <SelectField
            label="End joint"
            value={values.endJoint}
            options={JOINT_OPTIONS}
            blankLabel="Default (pinned)"
            onChange={set('endJoint')}
          />
        </>
      )}
      {values.role === 'column' && (
        <SelectField
          label="Base fixity"
          value={values.baseFixity}
          options={BASE_OPTIONS}
          blankLabel="Default (pinned / base plate)"
          onChange={set('baseFixity')}
        />
      )}
      <TextField label="Note" value={values.note} onChange={set('note')} />
      <button type="submit" className="btn btn--primary btn--sm" data-testid="member-save">
        Save member
      </button>
    </form>
  );
}
