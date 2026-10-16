import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { Material } from '@core/model/types';
import { densityToAnalysis, lengthUnitName, stressPerMpa, stressUnitName } from '@cae/decks/units';
import { idLines, linesText, num, row } from '@cae/decks/format';
import { ROOM_TEMPERATURE_K, elasticConstants, isElasticRefusal } from '@cae/decks/elastic';
import { barDocument } from './deckFixtures';

describe('INP number formatting', () => {
  it('writes at most 12 significant digits in the shortest form and never -0', () => {
    expect(num(210000)).toBe('210000');
    expect(num(0.1 + 0.2)).toBe('0.3');
    expect(num(1 / 3)).toBe('0.333333333333');
    expect(num(7.85e-9)).toBe('7.85e-9');
    expect(num(-0)).toBe('0');
    expect(num(-2.5)).toBe('-2.5');
    expect(row(1, 'P2', 0.5)).toBe('1, P2, 0.5');
  });

  it('wraps id lists at 16 per line and terminates lines', () => {
    const lines = idLines(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(lines).toEqual(['1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16', '17, 18']);
    expect(linesText(['a', 'b'])).toBe('a\nb\n');
    expect(linesText([])).toBe('');
  });
});

describe('unit conversions into the analysis unit systems', () => {
  it('converts stress from MPa', () => {
    expect(stressPerMpa('N-mm-t-s')).toBe(1);
    expect(stressPerMpa('N-m-kg-s')).toBe(1e6);
    expect(stressPerMpa('lbf-in-slinch-s')).toBeCloseTo(145.0377377, 6);
    expect([stressUnitName('N-mm-t-s'), stressUnitName('N-m-kg-s'), stressUnitName('lbf-in-slinch-s')]).toEqual(['MPa', 'Pa', 'psi']);
    expect([lengthUnitName('N-mm-t-s'), lengthUnitName('N-m-kg-s'), lengthUnitName('lbf-in-slinch-s')]).toEqual(['mm', 'm', 'in']);
  });

  it('converts steel density 0.00785 g/mm^3 (7850 kg/m^3) in each system', () => {
    expect(densityToAnalysis(0.00785, 'mm', 'N-mm-t-s')).toBeCloseTo(7.85e-9, 20);
    expect(densityToAnalysis(0.00785, 'mm', 'N-m-kg-s')).toBeCloseTo(7850, 6);
    // 7850 kg/m^3 = 7.34e-4 slinch/in^3 (1 slinch = 175.1268 kg)
    expect(densityToAnalysis(0.00785, 'mm', 'lbf-in-slinch-s')).toBeCloseTo(7.3459e-4, 7);
  });

  it('follows the document unit (g per cubic metre in a metre document)', () => {
    expect(densityToAnalysis(7.85e6, 'm', 'N-m-kg-s')).toBeCloseTo(7850, 6);
    expect(densityToAnalysis(7.85e6, 'm', 'N-mm-t-s')).toBeCloseTo(7.85e-9, 20);
  });
});

describe('elasticConstants', () => {
  const material = (doc: ReturnType<typeof barDocument>['doc']): Material => {
    const found = doc.materials['steel'];
    if (found === undefined) throw new Error('no steel');
    return found;
  };

  it('reads the default elastic_isotropic constitutive set in MPa', () => {
    const elastic = elasticConstants(material(barDocument().doc), 'steel', ROOM_TEMPERATURE_K);
    expect(isElasticRefusal(elastic)).toBe(false);
    expect(elastic).toMatchObject({ E: 210000, nu: 0.3 });
    expect((elastic as { source: string }).source).toContain('constitutive set linear');
  });

  it('falls back to the PHY-01 property models E and nu', () => {
    const elastic = elasticConstants(material(barDocument({ material: 'models' }).doc), 'steel', 300);
    expect(elastic).toMatchObject({ E: 210000, nu: 0.3 });
    expect((elastic as { source: string }).source).toContain('property models');
  });

  it('refuses a missing elastic law, an invalid nu and a non-isotropic set', () => {
    const bare: Material = { name: 'bare', density: 0.001, color: '#000000', metalness: 0, roughness: 0.5 };
    expect(elasticConstants(bare, 'bare', 293)).toMatchObject({ code: 'FEA_MATERIAL_NO_ELASTIC' });
    expect(elasticConstants(material(barDocument({ material: 'bad_nu' }).doc), 'steel', 293)).toMatchObject({
      code: 'FEA_PROPERTY_INVALID',
    });
    const ortho = execute(barDocument({ material: 'none' }).doc, 'create_material', {
      name: 'o',
      density: 0.001,
      color: '#000000',
      metalness: 0,
      roughness: 0.5,
    });
    const orthotropic: Material = {
      ...(ortho.document.materials['o'] as Material),
      materialModels: [
        {
          id: 'ortho',
          model: {
            kind: 'elastic_orthotropic',
            E1: { value: 1, unit: 'GPa' },
            E2: { value: 1, unit: 'GPa' },
            E3: { value: 1, unit: 'GPa' },
            nu12: { value: 0.3, unit: '1' },
            nu13: { value: 0.3, unit: '1' },
            nu23: { value: 0.3, unit: '1' },
            G12: { value: 1, unit: 'GPa' },
            G13: { value: 1, unit: 'GPa' },
            G23: { value: 1, unit: 'GPa' },
          },
        } as never,
      ],
      constitutiveSets: [{ id: 's', elastic: 'ortho' }],
      defaultConstitutiveSet: 's',
    };
    expect(elasticConstants(orthotropic, 'o', 293)).toMatchObject({ code: 'FEA_MATERIAL_ELASTIC_UNSUPPORTED' });
  });
});
