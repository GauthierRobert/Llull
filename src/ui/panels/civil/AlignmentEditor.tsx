/**
 * @layer ui/panels/civil
 *
 * AlignmentEditor — one road alignment: design profile PVIs (`set_alignment_profile`), road
 * template (`set_road_section`), superelevation (`set_superelevation`) and its deliverables
 * (report CSV, long / cross section SVG, plan-profile sheet on the chosen paper).
 */

import React, { useState } from 'react';
import type { AlignmentObject } from '@core/model/civil';
import { PAPER_SIZES, type PaperSize } from '@aec/sheet';
import { useStore } from '@ui/store';
import { OptionSelect } from '@ui/panels/OptionSelect';
import { CivilObjectRow, CivilStatus } from './CivilParts';
import { optionalNumber, parseNumber, parsePvis } from './civilInput';
import { downloadQuery } from './civilQuery';

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
    .map((pvi) =>
      pvi.curveLength > 0
        ? `${pvi.station}, ${pvi.elevation}, ${pvi.curveLength}`
        : `${pvi.station}, ${pvi.elevation}`,
    )
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
  const [superelevation, setSuperelevation] = useState(() =>
    alignment.superelevation ? String(alignment.superelevation.maxRate) : '',
  );
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
      ...SECTION_FIELDS.reduce(
        (params, [key]) => ({ ...params, ...optionalNumber(key, section[key]) }),
        {},
      ),
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
            <input
              type="number"
              value={superelevation}
              placeholder="Superelevation (0.06)"
              aria-label={`Superelevation of ${label}`}
              onChange={(event) => setSuperelevation(event.target.value)}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={applySuperelevation}>
              Set superelevation
            </button>
          </div>
          <div className="building-actions">
            <input
              type="number"
              value={designSpeed}
              placeholder="Design speed km/h"
              aria-label={`Design speed of ${label}`}
              onChange={(event) => setDesignSpeed(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setStatus(
                  downloadQuery(
                    'alignment_report',
                    { ...params, ...optionalNumber('designSpeedKmh', designSpeed) },
                    'csv',
                    `${alignment.id}-report.csv`,
                    'text/csv',
                  ),
                )
              }
            >
              Report CSV
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setStatus(
                  downloadQuery(
                    'export_long_section',
                    params,
                    'text',
                    `${alignment.id}-long-section.svg`,
                    'image/svg+xml',
                  ),
                )
              }
            >
              Long section SVG
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setStatus(
                  downloadQuery(
                    'export_cross_sections',
                    params,
                    'text',
                    `${alignment.id}-cross-sections.svg`,
                    'image/svg+xml',
                  ),
                )
              }
            >
              Cross sections SVG
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setStatus(
                  downloadQuery(
                    'export_plan_profile_sheet',
                    { ...params, paper },
                    'text',
                    `${alignment.id}-plan-profile.svg`,
                    'image/svg+xml',
                  ),
                )
              }
            >
              Plan-profile sheet
            </button>
            <OptionSelect
              value={paper}
              options={PAPER_SIZES}
              label={`Sheet paper of ${label}`}
              onChange={setPaper}
            />
          </div>
          <CivilStatus text={status} testId={`civil-alignment-status-${alignment.id}`} />
        </div>
      }
    />
  );
}
