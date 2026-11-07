// Mechanisms › Physics › Motors & drives: every motor of the rigid-body model with its stored parameters (the datasheet of a `dc` motor, the curve
// of an engine, the bound of a governor), the drive that commands it and the motion profiles. The only edit is the constant terminal voltage of
// a datasheet motor, sent through `set_motor_drive`; invalid text dispatches nothing.

import React, { useMemo, useState } from 'react';
import type { DynamicsModel, Motor } from '@core/model/dynamics';
import type { MotionProfile, MotorDrive } from '@core/model/drives';
import { useStore } from '@ui/store';
import { parseNumber } from '@ui/numberText';
import { FormError, ListRow, StatusLine } from '@ui/panels/PanelParts';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useFocusStore } from '@ui/store/focusStore';
import { motorFocus } from '@ui/panels/mechanismFocus';
import { driveFacts, driveHeadline, motorFacts, motorHeadline, profileView, type Fact } from '@ui/panels/motorSummary';

function Facts({ facts, testId }: { facts: readonly Fact[]; testId: string }): React.ReactElement {
  return (
    <dl className="physics-facts" data-testid={testId}>
      {facts.map((fact) => (
        <React.Fragment key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function VoltageEditor({ motorId, drive }: { motorId: string; drive: MotorDrive | undefined }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const voltsText = drive?.volts === undefined ? '' : String(drive.volts);
  const [text, setText] = useState(voltsText);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  // a plain constant-voltage drive (or none) is what this editor writes; anything else is replaced only after an explicit confirm
  const plain = drive === undefined || (drive.mode === 'voltage' && drive.profile === undefined);
  // the drive changed elsewhere (undo, live sync, CLI): show its value, and ask again before replacing a richer one
  const driveKey = `${voltsText}|${drive?.mode}|${drive?.profile}`;
  const [seenKey, setSeenKey] = useState(driveKey);
  if (seenKey !== driveKey) {
    setSeenKey(driveKey);
    setText(voltsText);
    setConfirmed(false);
  }
  const apply = (): void => {
    const volts = parseNumber(text);
    if (volts === undefined) {
      setError('Enter the terminal voltage in volts.');
      return;
    }
    setError('');
    void dispatch(
      'set_motor_drive',
      { motor: motorId, mode: 'voltage', volts, ...(drive?.currentLimitA === undefined ? {} : { currentLimitA: drive.currentLimitA }) },
      {
        onResult: ({ summary, changed }) => {
          if (changed) {
            setStatus(summary);
            setError('');
          } else {
            setStatus('');
            setError(summary);
          }
        },
      },
    );
  };
  if (!plain && !confirmed)
    return (
      <div className="physics-run" data-testid={`motor-voltage-${motorId}`}>
        <p className="panel__row-meta" data-testid={`motor-replace-note-${motorId}`}>
          This motor runs a {driveHeadline(drive)}. A constant voltage replaces it, with its profile, gains and limits.
        </p>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => setConfirmed(true)}
          data-testid={`motor-replace-${motorId}`}
        >
          Replace drive…
        </button>
      </div>
    );
  return (
    <div className="physics-run" data-testid={`motor-voltage-${motorId}`}>
      <label className="panel__row-meta" htmlFor={`motor-volts-${motorId}`}>
        Constant voltage (V)
      </label>
      <input
        id={`motor-volts-${motorId}`}
        className="physics-run__duration"
        type="number"
        step={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        data-testid={`motor-volts-${motorId}`}
      />
      <button type="button" className="btn btn--sm btn--ghost" onClick={apply} data-testid={`motor-volts-apply-${motorId}`}>
        Set drive
      </button>
      <FormError text={error} />
      <StatusLine text={status} testId={`motor-volts-status-${motorId}`} />
    </div>
  );
}

const profileOf = (dynamics: DynamicsModel | undefined, drive: MotorDrive | undefined): MotionProfile | undefined =>
  drive?.profile === undefined ? undefined : dynamics?.profiles?.[drive.profile];

function ProfileDetails({ profile }: { profile: MotionProfile }): React.ReactElement {
  const view = profileView(profile);
  return (
    <div className="physics-profile" data-testid={`profile-${profile.id}`}>
      <p className="panel__row-meta">
        <strong>{profile.id}</strong> · {view.headline}
      </p>
      <ol className="physics-profile__segments">
        {view.rows.map((row, index) => (
          <li key={index}>
            {row.startS === null ? '' : `t ${Number(row.startS.toFixed(4))} s · `}
            {row.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface MotorItemProps {
  readonly motor: Motor;
  readonly drive: MotorDrive | undefined;
  readonly profile: MotionProfile | undefined;
}

const MotorItem = React.memo(function MotorItem({ motor, drive, profile }: MotorItemProps): React.ReactElement {
  const focusItem = useFocusItem();
  const key = `mechanisms:motor:${motor.id}`;
  const focused = useFocusStore((state) => state.focus?.key === key);
  const facts = useMemo(() => [{ label: 'Joint', value: motor.joint }, ...motorFacts(motor)], [motor]);
  const driveRows = useMemo(() => (drive === undefined ? null : driveFacts(drive)), [drive]);
  return (
    <div className="physics-motor" data-testid={`physics-motor-${motor.id}`}>
      <ul className="panel__list" aria-label={`Motor ${motor.id}`}>
        <ListRow
          testId={`physics-motor-row-${motor.id}`}
          buttonTestId={`physics-motor-focus-${motor.id}`}
          swatch="#64dd17"
          selected={focused}
          onSelect={() => focusItem(motorFocus(useStore.getState().document, motor))}
        >
          <span className="panel__row-main">{motor.id}</span>
          <span className="panel__row-meta">{motorHeadline(motor)}</span>
        </ListRow>
      </ul>
      <details className="physics-motor__details">
        <summary>{motor.kind === 'dc' ? 'Datasheet and drive' : 'Parameters'}</summary>
        <Facts facts={facts} testId={`motor-facts-${motor.id}`} />
        {motor.kind === 'dc' && (
          <>
            {driveRows === null ? (
              <p className="panel__row-meta" data-testid={`motor-open-${motor.id}`}>
                No drive: the terminals are open, the motor adds its inertia and friction and no torque.
              </p>
            ) : (
              <Facts facts={driveRows} testId={`drive-facts-${motor.id}`} />
            )}
            {profile !== undefined && <ProfileDetails profile={profile} />}
            <VoltageEditor motorId={motor.id} drive={drive} />
          </>
        )}
      </details>
    </div>
  );
});

/** Motors (with their drive and profile) and the profiles no drive uses; null when the model has neither. */
export function PhysicsMotors({ dynamics }: { dynamics: DynamicsModel | undefined }): React.ReactElement | null {
  const motors = Object.values(dynamics?.motors ?? {});
  const used = new Set(Object.values(dynamics?.drives ?? {}).flatMap((drive) => (drive.profile === undefined ? [] : [drive.profile])));
  const spare = Object.values(dynamics?.profiles ?? {}).filter((profile) => !used.has(profile.id));
  if (motors.length === 0 && spare.length === 0) return null;
  return (
    <div className="physics-motors" data-testid="physics-motors">
      <h4 className="loads-group__title">Motors &amp; drives</h4>
      {motors.map((motor) => (
        <MotorItem
          key={motor.id}
          motor={motor}
          drive={dynamics?.drives?.[motor.id]}
          profile={profileOf(dynamics, dynamics?.drives?.[motor.id])}
        />
      ))}
      {spare.length > 0 && (
        <details className="physics-motor__details" data-testid="physics-profiles">
          <summary>Motion profiles not used by a drive ({spare.length})</summary>
          {spare.map((profile) => (
            <ProfileDetails key={profile.id} profile={profile} />
          ))}
        </details>
      )}
    </div>
  );
}
