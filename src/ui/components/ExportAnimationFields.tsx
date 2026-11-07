// The parameter fields of the "Export animation…" dialog: source, timing, camera, overlays, output. They only edit the form.

import React from 'react';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import {
  SIZE_PRESETS,
  type AnimationForm,
  type AnimationFormat,
  type AnimationQuality,
  type AnimationSourceKind,
  type AnimationView,
} from '@ui/services/animationExportModel';

interface FieldsProps {
  readonly form: AnimationForm;
  readonly update: (patch: Partial<AnimationForm>) => void;
}

const SOURCES: ReadonlyArray<readonly [AnimationSourceKind, string]> = [
  ['simulation', 'Physics simulation'],
  ['sweep', 'Joint / parameter sweep'],
  ['clips', 'Animation clips'],
  ['still', 'Camera only (orbit)'],
];
const VIEWS: readonly AnimationView[] = ['iso', 'front', 'top', 'right', 'left', 'back', 'bottom'];
const FORMATS: ReadonlyArray<readonly [AnimationFormat, string]> = [
  ['mp4', 'MP4 (AV1)'],
  ['gif', 'GIF'],
  ['apng', 'APNG'],
];
const QUALITIES: readonly AnimationQuality[] = ['draft', 'standard', 'high'];

interface CheckProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId: string;
}

function Check({ label, checked, onChange, testId }: CheckProps): React.ReactElement {
  return (
    <label className="export-animation__check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>{label}</span>
    </label>
  );
}

type TextKey = 'duration' | 'playbackRate' | 'target' | 'start' | 'end' | 'turns' | 'fps';

export function SourceFields({ form, update }: FieldsProps): React.ReactElement {
  const input = (label: string, key: TextKey, testId: string, type: 'text' | 'number' = 'number'): React.ReactElement => (
    <LabeledInput
      label={label}
      type={type}
      value={form[key]}
      testId={testId}
      onChange={(value) => update({ [key]: value })}
      inputProps={type === 'number' ? { step: 'any' } : {}}
    />
  );
  return (
    <fieldset className="export-animation__group">
      <legend>What moves</legend>
      <LabeledSelect
        label="Source"
        value={form.source}
        options={SOURCES}
        testId="export-animation-source"
        onChange={(value) => update({ source: SOURCES.find(([kind]) => kind === value)?.[0] ?? 'simulation' })}
      />
      {input(form.source === 'simulation' ? 'Simulated seconds' : 'Video seconds', 'duration', 'export-animation-duration')}
      {form.source === 'simulation' && input('Playback rate (s of motion per video s)', 'playbackRate', 'export-animation-rate')}
      {form.source === 'sweep' && (
        <>
          <LabeledSelect
            label="Drive"
            value={form.sweepMode}
            options={[
              ['joint', 'a joint'],
              ['parameter', 'a parameter'],
            ]}
            testId="export-animation-sweep-mode"
            onChange={(value) => update({ sweepMode: value === 'parameter' ? 'parameter' : 'joint' })}
          />
          {input(form.sweepMode === 'joint' ? 'Joint id' : 'Parameter name', 'target', 'export-animation-target', 'text')}
          {input('Start (° for a revolute joint)', 'start', 'export-animation-start')}
          {input('End', 'end', 'export-animation-end')}
          <Check
            label="Go back to the start (ping-pong)"
            checked={form.pingPong}
            onChange={(pingPong) => update({ pingPong })}
            testId="export-animation-pingpong"
          />
        </>
      )}
    </fieldset>
  );
}

export function CameraFields({ form, update }: FieldsProps): React.ReactElement {
  return (
    <fieldset className="export-animation__group">
      <legend>Camera and overlays</legend>
      <LabeledSelect
        label="View"
        value={form.view}
        options={VIEWS.map((view) => [view, view] as const)}
        testId="export-animation-view"
        onChange={(value) => update({ view: VIEWS.find((view) => view === value) ?? 'iso' })}
      />
      <Check label="Orbit around the scene" checked={form.orbit} onChange={(orbit) => update({ orbit })} testId="export-animation-orbit" />
      {form.orbit && (
        <>
          <LabeledInput
            label="Turns"
            type="number"
            value={form.turns}
            testId="export-animation-turns"
            onChange={(turns) => update({ turns })}
            inputProps={{ step: 'any' }}
          />
          <Check label="Seamless loop" checked={form.loop} onChange={(loop) => update({ loop })} testId="export-animation-loop" />
        </>
      )}
      <Check label="Show the time" checked={form.time} onChange={(time) => update({ time })} testId="export-animation-time" />
      <Check
        label="Highlight moving parts"
        checked={form.highlight}
        onChange={(highlight) => update({ highlight })}
        testId="export-animation-highlight"
      />
    </fieldset>
  );
}

export function OutputFields({ form, update }: FieldsProps): React.ReactElement {
  return (
    <fieldset className="export-animation__group">
      <legend>File</legend>
      <LabeledSelect
        label="Format"
        value={form.format}
        options={FORMATS}
        testId="export-animation-format"
        onChange={(value) => update({ format: FORMATS.find(([format]) => format === value)?.[0] ?? 'mp4' })}
      />
      {form.format === 'mp4' && (
        <LabeledSelect
          label="Quality"
          value={form.quality}
          options={QUALITIES.map((quality) => [quality, quality] as const)}
          testId="export-animation-quality"
          onChange={(value) => update({ quality: QUALITIES.find((quality) => quality === value) ?? 'standard' })}
        />
      )}
      <LabeledSelect
        label="Size"
        value={form.size}
        options={SIZE_PRESETS.map((size) => [size, size.replace('x', ' × ')] as const)}
        testId="export-animation-size"
        onChange={(value) => update({ size: SIZE_PRESETS.find((size) => size === value) ?? '1280x720' })}
      />
      <LabeledInput
        label="Frames per second"
        type="number"
        value={form.fps}
        testId="export-animation-fps"
        onChange={(fps) => update({ fps })}
        inputProps={{ min: 1, max: 60, step: 1 }}
      />
    </fieldset>
  );
}
