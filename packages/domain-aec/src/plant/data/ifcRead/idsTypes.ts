/** The IDS 1.0 subset `check_ifc_requirements` understands (plant 08 DAT §5.12): facets entity, attribute, property, classification, partOf; values simple, enumeration, pattern, bounds. */

export interface ValueRule {
  /** `simpleValue`: compared as text (numbers also numerically). */
  readonly simple?: string;
  readonly enumeration?: readonly string[];
  /** Anchored, already checked for catastrophic shapes. */
  readonly patterns?: readonly RegExp[];
  readonly bounds?: {
    readonly minInclusive?: number;
    readonly maxInclusive?: number;
    readonly minExclusive?: number;
    readonly maxExclusive?: number;
  };
}

export type Cardinality = 'required' | 'optional' | 'prohibited';

export interface EntityFacet {
  readonly type: 'entity';
  readonly name: ValueRule;
  readonly predefinedType?: ValueRule;
}

export type Facet =
  | EntityFacet
  | { readonly type: 'attribute'; readonly name: ValueRule; readonly value?: ValueRule; readonly cardinality: Cardinality }
  | {
      readonly type: 'property';
      readonly propertySet: ValueRule;
      readonly baseName: ValueRule;
      readonly value?: ValueRule;
      readonly dataType?: string;
      readonly cardinality: Cardinality;
    }
  | { readonly type: 'classification'; readonly system?: ValueRule; readonly value?: ValueRule; readonly cardinality: Cardinality }
  | { readonly type: 'partOf'; readonly relation?: string; readonly entity: EntityFacet; readonly cardinality: Cardinality };

export interface Specification {
  readonly name: string;
  readonly ifcVersions: readonly string[];
  /** `minOccurs` of the applicability: 0 = an empty applicability is fine, 1 (default) = at least one applicable entity is required. */
  readonly minOccurs: number;
  readonly applicability: readonly Facet[];
  readonly requirements: readonly Facet[];
}

export interface Ids {
  readonly title: string;
  readonly specifications: readonly Specification[];
}
