/**
 * @layer ui/components
 *
 * MeasurementHUD — overlay showing the result of the most recent read-only query command
 * (`lastMeasure`: measure_distance / angle / area / perimeter / bounding_box / volume,
 * mass_properties). Renders nothing without a measurement; the close button clears it.
 * Presentation ONLY (PRIME DIRECTIVE).
 */

import React from 'react';
import { useStore } from '@ui/store';
import { isRecord } from '@lib/isRecord';
import { Icon } from './Icon';

interface DistanceData {
  distance: number;
  unit: string;
}
interface AngleData {
  degrees: number;
  radians: number;
}
interface AreaData {
  area: number;
  unit: string;
}
interface PerimeterData {
  perimeter: number;
  unit: string;
}
interface BoundingBoxData {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  size: readonly [number, number, number];
}
interface VolumeData {
  volume: number;
  unit: string;
}
interface MassPropertiesData {
  volume: number;
  density: number;
  mass: number;
  unit: string;
}

/** Shape probe: an object holding every `required` key and none of the `forbidden` ones. */
function hasShape(
  data: unknown,
  required: readonly string[],
  forbidden: readonly string[] = [],
): boolean {
  return (
    isRecord(data) && required.every((key) => key in data) && !forbidden.some((key) => key in data)
  );
}

function isDistanceData(data: unknown): data is DistanceData {
  return hasShape(data, ['distance', 'unit'], ['area', 'perimeter', 'volume']);
}

function isAngleData(data: unknown): data is AngleData {
  return hasShape(data, ['degrees', 'radians']);
}

function isAreaData(data: unknown): data is AreaData {
  return hasShape(data, ['area', 'unit']);
}

function isPerimeterData(data: unknown): data is PerimeterData {
  return hasShape(data, ['perimeter', 'unit']);
}

function isBoundingBoxData(data: unknown): data is BoundingBoxData {
  return hasShape(data, ['min', 'max', 'size']);
}

function isVolumeData(data: unknown): data is VolumeData {
  return hasShape(data, ['volume', 'unit'], ['density']);
}

function isMassPropertiesData(data: unknown): data is MassPropertiesData {
  return hasShape(data, ['volume', 'density', 'mass', 'unit']);
}

function fmt(n: number, precision = 3): string {
  return n.toFixed(precision);
}

function fmtVec3(v: readonly [number, number, number], precision = 3): string {
  return `(${fmt(v[0], precision)}, ${fmt(v[1], precision)}, ${fmt(v[2], precision)})`;
}

interface RowProps {
  label: string;
  value: string;
  unit?: string;
}

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
  return <Row label="Distance" value={fmt(data.distance)} unit={data.unit} />;
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
  return <Row label="Area" value={fmt(data.area)} unit={data.unit} />;
}

function PerimeterResult({ data }: { data: PerimeterData }): React.ReactElement {
  return <Row label="Perimeter" value={fmt(data.perimeter)} unit={data.unit} />;
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
  return <Row label="Volume" value={fmt(data.volume)} unit={data.unit} />;
}

function MassPropertiesResult({ data }: { data: MassPropertiesData }): React.ReactElement {
  return (
    <>
      <Row
        label="Volume"
        value={fmt(data.volume)}
        unit={`${data.unit.replace('g', '')}³`.trim() || 'mm³'}
      />
      <Row
        label="Density"
        value={fmt(data.density, 5)}
        unit={`g/${data.unit.replace('g', '') || 'mm'}³`}
      />
      <Row label="Mass" value={fmt(data.mass)} unit={data.unit} />
    </>
  );
}

const COMMAND_TITLES: Record<string, string> = {
  measure_distance: 'Distance',
  measure_angle: 'Angle',
  measure_area: 'Area',
  measure_perimeter: 'Perimeter',
  measure_bounding_box: 'Bounding Box',
  measure_volume: 'Volume',
  mass_properties: 'Mass Properties',
};

export function MeasurementHUD(): React.ReactElement | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const clearLastMeasure = useStore((s) => s.clearLastMeasure);

  if (!lastMeasure) return null;

  const { command, data } = lastMeasure;
  const isKnownMeasurement =
    isDistanceData(data) ||
    isAngleData(data) ||
    isAreaData(data) ||
    isPerimeterData(data) ||
    isBoundingBoxData(data) ||
    isVolumeData(data) ||
    isMassPropertiesData(data);
  if (!isKnownMeasurement) return null;
  const title = COMMAND_TITLES[command] ?? command;

  return (
    <div className="mhud" role="region" aria-label={`Measurement result: ${title}`}>
      <div className="mhud-header">
        <span className="mhud-title">
          <Icon name="ruler" size={14} />
          {title}
        </span>
        <button
          type="button"
          className="mhud-dismiss"
          onClick={clearLastMeasure}
          aria-label="Dismiss measurement"
          title="Dismiss"
        >
          <Icon name="close" size={12} />
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
