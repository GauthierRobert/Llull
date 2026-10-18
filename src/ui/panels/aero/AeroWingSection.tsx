// Wing section: finite-wing lift and induced drag by lifting-line theory (analyze_wing) — planform maths, independent of the model.

import React, { useMemo, useState } from 'react';
import { execute } from '@core/commands/registry';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { FormError, KpiStrip, PanelSection } from '@ui/panels/PanelParts';
import { parseWing } from './aeroData';

interface WingInputs {
  span: string;
  rootChord: string;
  tipChord: string;
}

export function AeroWingSection({ alphaDeg }: { alphaDeg: number }): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const [inputs, setInputs] = useState<WingInputs>({ span: '10', rootChord: '1.2', tipChord: '0.8' });
  const outcome = useMemo(() => {
    const [span, rootChord, tipChord] = [Number(inputs.span), Number(inputs.rootChord), Number(inputs.tipChord)];
    const result = execute(document, 'analyze_wing', { span, rootChord, tipChord, alphasDeg: [alphaDeg] });
    return { view: parseWing(result.data), summary: result.summary };
  }, [document, inputs, alphaDeg]);
  const row = outcome.view?.rows[0];
  const field = (key: keyof WingInputs, label: string): React.ReactElement => (
    <LabeledInput
      label={label}
      type="number"
      value={inputs[key]}
      inputProps={{ min: 0, step: 0.1 }}
      onChange={(value) => setInputs({ ...inputs, [key]: value })}
    />
  );
  return (
    <PanelSection
      title="Wing"
      hint={`Finite wing at ${alphaDeg}° angle of attack (lifting-line theory, metres; not tied to a model).`}
      collapsible
      defaultOpen={false}
      testId="aero-wing"
    >
      <div className="aero__inputs">
        {field('span', 'Span (m)')}
        {field('rootChord', 'Root chord (m)')}
        {field('tipChord', 'Tip chord (m)')}
      </div>
      <FormError text={outcome.view === null ? outcome.summary : ''} />
      {outcome.view !== null && row !== undefined && (
        <KpiStrip
          label="Wing results"
          items={[
            { key: 'wing-cl', label: 'Lift CL', value: row.cl.toFixed(3) },
            { key: 'wing-cdi', label: 'Induced drag CDi', value: row.cdi.toFixed(4) },
            {
              key: 'wing-e',
              label: 'Span efficiency e',
              value: row.efficiency.toFixed(3),
              sub: `AR ${outcome.view.aspectRatio.toFixed(1)}`,
            },
          ]}
        />
      )}
    </PanelSection>
  );
}
