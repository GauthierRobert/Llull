/** Steel member inspector editor: Save dispatches ONE `update_steel_member` with the changed fields. */

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
import { ALL_PROFILES, BASE_OPTIONS, JOINT_OPTIONS, MEMBER_ROLE_OPTIONS } from './steelProfileOptions';
import { CommandForm } from '@ui/panels/CommandForm';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';

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

  const handleSubmit = (): void => {
    const params = buildSteelMemberUpdate(member.id, initial, values, horizontal && keepTopOfSteel);
    if (params !== null) dispatch('update_steel_member', params);
  };

  return (
    <CommandForm
      ariaLabel={`Steel member ${member.mark} properties`}
      testId="steel-member-editor"
      submitLabel="Save member"
      submitTestId="member-save"
      onSubmit={handleSubmit}
    >
      <LabeledSelect label="Profile" value={values.profile} options={ALL_PROFILES} onChange={set('profile')} />
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
      <LabeledInput label="Grade" type="text" value={values.material} onChange={set('material')} />
      <LabeledSelect label="Role" value={values.role} options={MEMBER_ROLE_OPTIONS} onChange={set('role')} />
      {values.role === 'beam' && (
        <>
          <LabeledSelect
            label="Start joint"
            value={values.startJoint}
            options={JOINT_OPTIONS}
            blankLabel="Default (pinned)"
            onChange={set('startJoint')}
          />
          <LabeledSelect
            label="End joint"
            value={values.endJoint}
            options={JOINT_OPTIONS}
            blankLabel="Default (pinned)"
            onChange={set('endJoint')}
          />
        </>
      )}
      {values.role === 'column' && (
        <LabeledSelect
          label="Base fixity"
          value={values.baseFixity}
          options={BASE_OPTIONS}
          blankLabel="Default (pinned / base plate)"
          onChange={set('baseFixity')}
        />
      )}
      <LabeledInput label="Note" type="text" value={values.note} onChange={set('note')} />
    </CommandForm>
  );
}
