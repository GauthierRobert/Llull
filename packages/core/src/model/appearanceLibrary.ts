/** Offline appearance library (RV1 RV-M1, closes G8): physically based values only, no image files. `apply_appearance` copies an entry. */

import type { Appearance, ColorChannel } from './appearance';

export interface LibraryAppearance {
  readonly id: string;
  readonly name: string;
  readonly category: 'metal' | 'coating' | 'mineral' | 'glass' | 'polymer';
  readonly description: string;
  /** True when a caller-chosen colour is the point of the entry (paint): `apply_appearance color` replaces its base colour. */
  readonly tintable: boolean;
  readonly appearance: Appearance;
}

const colored = (value: string): ColorChannel => ({ value });
const scalar = (value: number): { readonly value: number } => ({ value });

/** @invariant every entry's baseColor value is `#rrggbb`; metalness, roughness, transmission, coat in [0, 1]; ior in [1, 3] */
export const APPEARANCE_LIBRARY: readonly LibraryAppearance[] = [
  {
    id: 'steel',
    name: 'Structural steel',
    category: 'metal',
    description: 'Mill-finish carbon steel, grey, metallic, medium roughness.',
    tintable: false,
    appearance: { baseColor: colored('#8a8d91'), metalness: scalar(1), roughness: scalar(0.45) },
  },
  {
    id: 'stainless',
    name: 'Stainless steel',
    category: 'metal',
    description: 'Brushed stainless steel (304), bright, metallic, low roughness.',
    tintable: false,
    appearance: { baseColor: colored('#c4c7ca'), metalness: scalar(1), roughness: scalar(0.3) },
  },
  {
    id: 'galvanised',
    name: 'Galvanised steel',
    category: 'metal',
    description: 'Hot-dip galvanised steel, dull spangled zinc grey.',
    tintable: false,
    appearance: { baseColor: colored('#a9b0b5'), metalness: scalar(1), roughness: scalar(0.55) },
  },
  {
    id: 'painted',
    name: 'Painted (gloss paint)',
    category: 'coating',
    description: 'Gloss paint over a dielectric substrate with a clear coat; pass `color` for the paint colour (default red).',
    tintable: true,
    appearance: { baseColor: colored('#b3262b'), metalness: scalar(0), roughness: scalar(0.4), coat: scalar(0.3), coatRoughness: 0.1 },
  },
  {
    id: 'concrete',
    name: 'Concrete',
    category: 'mineral',
    description: 'Cast concrete, light grey, rough, non-metallic.',
    tintable: false,
    appearance: { baseColor: colored('#9a9a96'), metalness: scalar(0), roughness: scalar(0.9) },
  },
  {
    id: 'insulation_cladding',
    name: 'Insulation cladding (aluminium)',
    category: 'metal',
    description: 'Aluminium jacketing of insulated pipes and vessels, satin metallic.',
    tintable: false,
    appearance: { baseColor: colored('#c9cdd1'), metalness: scalar(1), roughness: scalar(0.35) },
  },
  {
    id: 'glass',
    name: 'Clear glass',
    category: 'glass',
    description: 'Clear float glass: full transmission, index of refraction 1.5, nearly smooth.',
    tintable: false,
    appearance: { baseColor: colored('#dff0f5'), metalness: scalar(0), roughness: scalar(0.05), transmission: scalar(1), ior: 1.5 },
  },
  {
    id: 'rubber',
    name: 'Rubber',
    category: 'polymer',
    description: 'Black vulcanised rubber, rough, non-metallic.',
    tintable: false,
    appearance: { baseColor: colored('#1e1e1e'), metalness: scalar(0), roughness: scalar(0.85) },
  },
  {
    id: 'copper',
    name: 'Copper',
    category: 'metal',
    description: 'Polished copper, warm metallic.',
    tintable: false,
    appearance: { baseColor: colored('#b87333'), metalness: scalar(1), roughness: scalar(0.3) },
  },
  {
    id: 'brass',
    name: 'Brass',
    category: 'metal',
    description: 'Polished brass, yellow metallic.',
    tintable: false,
    appearance: { baseColor: colored('#b5a642'), metalness: scalar(1), roughness: scalar(0.3) },
  },
];

export function libraryAppearance(id: string): LibraryAppearance | undefined {
  return APPEARANCE_LIBRARY.find((entry) => entry.id === id);
}
