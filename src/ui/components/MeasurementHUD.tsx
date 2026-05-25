/**
 * @layer ui/components
 *
 * MeasurementHUD — an HTML overlay that displays the result of the most recent
 * read-only/query command (measure_distance, measure_angle, measure_area,
 * measure_perimeter, measure_bounding_box, measure_volume, mass_properties).
 *
 * Reads `lastMeasure` from the Zustand store (narrow selector — R3).
 * Renders nothing when there is no current measurement.
 * Dismissable via a close button that calls `clearLastMeasure()`.
 *
 * Presentation ONLY — never mutates the document (PRIME DIRECTIVE).
 * Styled with CSS variables from the design system (V3).
 */

import React from 'react';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Typed data shapes (local — mirror the command data interfaces for narrowing)
// ---------------------------------------------------------------------------

interface DistanceData { distance: number; unit: string; }
interface AngleData { degrees: number; radians: number; }
interface AreaData { area: number; unit: string; }
interface PerimeterData { perimeter: number; unit: string; }
interface BoundingBoxData {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  size: readonly [number, number, number];
}
interface VolumeData { volume: number; unit: string; }
interface MassPropertiesData { volume: number; density: number; mass: number; unit: string; }

// ---------------------------------------------------------------------------
// Type-guard helpers (narrow `unknown` data without unsafe casts)
// ---------------------------------------------------------------------------

function isDistanceData(d: unknown): d is DistanceData {
  return typeof d === 'object' && d !== null && 'distance' in d && 'unit' in d && !('area' in d) && !('perimeter' in d) && !('volume' in d);
}

function isAngleData(d: unknown): d is AngleData {
  return typeof d === 'object' && d !== null && 'degrees' in d && 'radians' in d;
}

function isAreaData(d: unknown): d is AreaData {
  return typeof d === 'object' && d !== null && 'area' in d && 'unit' in d;
}

function isPerimeterData(d: unknown): d is PerimeterData {
  return typeof d === 'object' && d !== null && 'perimeter' in d && 'unit' in d;
}

function isBoundingBoxData(d: unknown): d is BoundingBoxData {
  return typeof d === 'object' && d !== null && 'min' in d && 'max' in d && 'size' in d;
}

function isVolumeData(d: unknown): d is VolumeData {
  return typeof d === 'object' && d !== null && 'volume' in d && 'unit' in d && !('density' in d);
}

function isMassPropertiesData(d: unknown): d is MassPropertiesData {
  return typeof d === 'object' && d !== null && 'volume' in d && 'density' in d && 'mass' in d && 'unit' in d;
}

// ---------------------------------------------------------------------------
// Formatters — keep display clean
// ---------------------------------------------------------------------------

function fmt(n: number, precision = 3): string {
  return n.toFixed(precision);
}

function fmtVec3(v: readonly [number, number, number], precision = 3): string {
  return `(${fmt(v[0], precision)}, ${fmt(v[1], precision)}, ${fmt(v[2], precision)})`;
}

// ---------------------------------------------------------------------------
// Per-command result renderers
// ---------------------------------------------------------------------------

interface RowProps { label: string; value: string; unit?: string; }

function Row({ label, value, unit }: RowProps): React.ReactElement {
  return (
    <div className="mhud-row">
      <span className="mhud-label">{label}</span>
      <span className="mhud-value">
        {value}
        {unit && <span className="mhud-unit"> {unit}</span>}
      </span>
    </div>
  );
}

function DistanceResult({ data }: { data: DistanceData }): React.ReactElement {
  return (
    <Row label="Distance" value={fmt(data.distance)} unit={data.unit} />
  );
}

function AngleResult({ data }: { data: AngleData }): React.ReactElement {
  return (
    <>
      <Row label="Angle" value={fmt(data.degrees, 4)} unit="deg" />
      <Row label="" value={fmt(data.radians, 6)} unit="rad" />
    </>
  );
}

function AreaResult({ data }: { data: AreaData }): React.ReactElement {
  return (
    <Row label="Area" value={fmt(data.area)} unit={data.unit} />
  );
}

function PerimeterResult({ data }: { data: PerimeterData }): React.ReactElement {
  return (
    <Row label="Perimeter" value={fmt(data.perimeter)} unit={data.unit} />
  );
}

function BoundingBoxResult({ data }: { data: BoundingBoxData }): React.ReactElement {
  return (
    <>
      <Row label="Min" value={fmtVec3(data.min)} />
      <Row label="Max" value={fmtVec3(data.max)} />
      <Row label="Size" value={fmtVec3(data.size)} />
    </>
  );
}

function VolumeResult({ data }: { data: VolumeData }): React.ReactElement {
  return (
    <Row label="Volume" value={fmt(data.volume)} unit={data.unit} />
  );
}

function MassPropertiesResult({ data }: { data: MassPropertiesData }): React.ReactElement {
  return (
    <>
      <Row label="Volume" value={fmt(data.volume)} unit={`${data.unit.replace('g', '')}³`.trim() || 'mm³'} />
      <Row label="Density" value={fmt(data.density, 5)} unit={`g/${data.unit.replace('g', '') || 'mm'}³`} />
      <Row label="Mass" value={fmt(data.mass)} unit={data.unit} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Title per command
// ---------------------------------------------------------------------------

const COMMAND_TITLES: Record<string, string> = {
  measure_distance: 'Distance',
  measure_angle: 'Angle',
  measure_area: 'Area',
  measure_perimeter: 'Perimeter',
  measure_bounding_box: 'Bounding Box',
  measure_volume: 'Volume',
  mass_properties: 'Mass Properties',
};

// ---------------------------------------------------------------------------
// MeasurementHUD — the exported component
// ---------------------------------------------------------------------------

export function MeasurementHUD(): React.ReactElement | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const clearLastMeasure = useStore((s) => s.clearLastMeasure);

  if (!lastMeasure) return null;

  const { command, data } = lastMeasure;
  const title = COMMAND_TITLES[command] ?? command;

  return (
    <div className="mhud" role="region" aria-label={`Measurement result: ${title}`}>
      <div className="mhud-header">
        <span className="mhud-title">{title}</span>
        <button
          type="button"
          className="mhud-dismiss"
          onClick={clearLastMeasure}
          aria-label="Dismiss measurement"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="mhud-body">
        {isDistanceData(data) && <DistanceResult data={data} />}
        {isAngleData(data) && <AngleResult data={data} />}
        {isAreaData(data) && <AreaResult data={data} />}
        {isPerimeterData(data) && <PerimeterResult data={data} />}
        {isBoundingBoxData(data) && <BoundingBoxResult data={data} />}
        {isMassPropertiesData(data) && <MassPropertiesResult data={data} />}
        {isVolumeData(data) && !isMassPropertiesData(data) && <VolumeResult data={data} />}
      </div>
    </div>
  );
}
