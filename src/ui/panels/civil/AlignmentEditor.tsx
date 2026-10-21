// One road alignment: profile PVIs, road template, superelevation, deliverables (report CSV, long / cross SVG, sheet).

import React, { useState } from 'react';
import type { AlignmentObject } from '@aec/index';
import { PAPER_SIZES, type PaperSize } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { CivilObjectRow, NumberTextField } from './CivilParts';
import { StatusLine } from '@ui/panels/PanelParts';
import { QueryDownloadButton } from '@ui/panels/QueryDownloadButton';
import { optionalNumber, parseNumber } from '@ui/numberText';
import { parsePvis } from './civilInput';

const SECTION_FIELDS = [
  ['laneWidth', 'Lane width'],
  ['shoulderWidth', 'Shoulder width'],
  ['crossfall', 'Crossfall (0.025)'],
  ['cutSlope', 'Cut H:1V'],
  ['fillSlope', 'Fill H:1V'],
] as const;

type SectionKey = (typeof SECTION_FIELDS)[number][0];

const profileText = (alignment: AlignmentObject): string =>
  alignment.profile
    .map((pvi) => (pvi.curveLength > 0 ? `${pvi.station}, ${pvi.elevation}, ${pvi.curveLength}` : `${pvi.station}, ${pvi.elevation}`))
    .join('\n');

export function AlignmentEditor({ alignment }: { alignment: AlignmentObject }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [pvis, setPvis] = useState(() => profileText(alignment));
  const [section, setSection] = useState<Record<SectionKey, string>>({
    laneWidth: '',
    shoulderWidth: '',
    crossfall: '',
    cutSlope: '',
    fillSlope: '',
  });
  const [designSpeed, setDesignSpeed] = useState('');
  const [superelevation, setSuperelevation] = useState(() => (alignment.superelevation ? String(alignment.superelevation.maxRate) : ''));
  const [paper, setPaper] = useState<PaperSize>('A3');
  const [status, setStatus] = useState('');
  const label = alignment.name;

  const applyProfile = (): void => {
    const parsed = parsePvis(pvis);
    if (parsed === null || parsed.length < 2) {
      setStatus('Profile: one "station, elevation[, curve length]" per line, at least 2 rows.');
      return;
    }
    dispatch('set_alignment_profile', { alignmentId: alignment.id, pvis: parsed });
    setStatus('');
  };

  const applySection = (): void => {
    dispatch('set_road_section', {
      alignmentId: alignment.id,
      ...SECTION_FIELDS.reduce((params, [key]) => ({ ...params, ...optionalNumber(key, section[key]) }), {}),
    });
  };

  const applySuperelevation = (): void => {
    const maxRate = parseNumber(superelevation);
    if (maxRate === undefined) {
      setStatus('Superelevation: the full rate on curves as a ratio, e.g. 0.06 (0 removes it).');
      return;
    }
    dispatch('set_superelevation', { alignmentId: alignment.id, maxRate });
    setStatus('');
  };

  const params = { alignmentId: alignment.id };
  return (
    <CivilObjectRow
      object={alignment}
      detail={`${alignment.points.length} PIs, ${alignment.profile.length} PVIs${alignment.section ? ', road section set' : ''}`}
      body={
        <div className="civil-form">
          <textarea
            value={pvis}
            rows={3}
            placeholder={'0, 100\n120, 102.5, 60\n300, 101'}
            aria-label={`Profile PVIs of ${label}`}
            onChange={(event) => setPvis(event.target.value)}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={applyProfile}>
            Set profile
          </button>
          <div className="building-inline-form">
            {SECTION_FIELDS.map(([key, placeholder]) => (
              <input
                key={key}
                type="number"
                value={section[key]}
                placeholder={placeholder}
                aria-label={`${placeholder} of ${label}`}
                onChange={(event) => setSection((prev) => ({ ...prev, [key]: event.target.value }))}
              />
            ))}
            <button type="button" className="btn btn--ghost btn--sm" onClick={applySection}>
              Set road section
            </button>
          </div>
          <div className="building-inline-form">
            <NumberTextField
              value={superelevation}
              set={setSuperelevation}
              hint="Superelevation (0.06)"
              label={`Superelevation of ${label}`}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={applySuperelevation}>
              Set superelevation
            </button>
          </div>
          <div className="building-actions">
            <NumberTextField value={designSpeed} set={setDesignSpeed} hint="Design speed km/h" label={`Design speed of ${label}`} />
            <QueryDownloadButton
              label="Report CSV"
              command="alignment_report"
              params={{ ...params, ...optionalNumber('designSpeedKmh', designSpeed) }}
              field="csv"
              fallbackName={`${alignment.id}-report.csv`}
              mimeType="text/csv"
              onStatus={setStatus}
            />
            <QueryDownloadButton
              label="Long section SVG"
              command="export_road_long_section"
              params={params}
              field="text"
              fallbackName={`${alignment.id}-long-section.svg`}
              mimeType="image/svg+xml"
              onStatus={setStatus}
            />
            <QueryDownloadButton
              label="Cross sections SVG"
              command="export_cross_sections"
              params={params}
              field="text"
              fallbackName={`${alignment.id}-cross-sections.svg`}
              mimeType="image/svg+xml"
              onStatus={setStatus}
            />
            <QueryDownloadButton
              label="Plan-profile sheet"
              command="export_plan_profile_sheet"
              params={{ ...params, paper }}
              field="text"
              fallbackName={`${alignment.id}-plan-profile.svg`}
              mimeType="image/svg+xml"
              onStatus={setStatus}
            />
            <OptionSelect value={paper} options={PAPER_SIZES} label={`Sheet paper of ${label}`} onChange={setPaper} />
          </div>
          <StatusLine text={status} testId={`civil-alignment-status-${alignment.id}`} />
        </div>
      }
    />
  );
}
