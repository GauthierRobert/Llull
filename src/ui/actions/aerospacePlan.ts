// Aerospace starter ("UAV propulsion pod") as ONE `build_project` plan: the geometry (aerospaceGeometry), then sourced
// material records, NAS6203 bolt rows from the sample catalogue, a MuJoCo rigid-body propulsion drive, a static FE case
// (limit thrust + 10 g, fitting factor) and a steady thermal case on the pylon fitting, and an A3 drawing sheet.
// Pure data: the UI starter, the CLI and the tests all replay exactly these actions.

import {
  AXIS_Z,
  BOLT_X_FIRST,
  BOLT_X_LAST,
  STARTER_FITTING,
  PROP_DIAMETER,
  PROP_X,
  WEB_FRONT,
  aerospaceGeometryActions,
  fittingLayout,
  type FittingDesign,
  type FittingLayout,
  type PlanAction,
} from '@ui/actions/aerospaceGeometry';

const S12 = {
  citation: 'ASM / MatWeb, Aluminum 7075-T6; 7075-T651',
  url: 'https://asm.matweb.com/search/specificmaterial.asp?bassnum=ma7075t6',
};
const S10 = {
  citation: 'MatWeb, Aluminum 2024-T3',
  url: 'https://www.matweb.com/search/datasheet.aspx?MatGUID=57483b4d782940faaf12964a1821fb61',
};
const S8 = { citation: 'MIL-HDBK-5J via KasperCalc transcription (secondary, confirm)', locator: 'Table 3.2.3.0(b1), AMS 4037 bare sheet' };

interface PropertyValue {
  property: string;
  value: number;
  unit: string;
  basis: 'A' | 'typical';
}

const property = (
  material: string,
  value: PropertyValue,
  source: Record<string, string>,
  extra: Record<string, unknown> = {},
): PlanAction => ({ command: 'set_material_property', params: { material, ...value, source, ...extra } });

function materialActions(): PlanAction[] {
  const al7075: PropertyValue[] = [
    { property: 'density', value: 2.81, unit: 'g/cm^3', basis: 'typical' },
    { property: 'E', value: 71.7, unit: 'GPa', basis: 'typical' },
    { property: 'nu', value: 0.33, unit: '1', basis: 'typical' },
    { property: 'Ftu', value: 572, unit: 'MPa', basis: 'typical' },
    { property: 'Fty', value: 503, unit: 'MPa', basis: 'typical' },
    { property: 'k', value: 130, unit: 'W/(m*K)', basis: 'typical' },
    { property: 'cp', value: 960, unit: 'J/(kg*K)', basis: 'typical' },
  ];
  const al2024: PropertyValue[] = [
    { property: 'density', value: 2.78, unit: 'g/cm^3', basis: 'typical' },
    { property: 'E', value: 73.1, unit: 'GPa', basis: 'typical' },
    { property: 'nu', value: 0.33, unit: '1', basis: 'typical' },
  ];
  const sheetRange = { direction: 'L', thickness: { min: 0.02, max: 0.128, unit: 'in' } };
  return [
    {
      command: 'define_material_record',
      params: {
        id: 'aa7075_t6',
        designation: '7075',
        temper: 'T6',
        productForm: 'plate',
        specs: [{ body: 'SAE', id: 'AMS 4045' }],
        licence: 'vendor-catalogue',
        exportMarking: { regime: 'none' },
        color: '#b8c2cc',
      },
    },
    ...al7075.map((value) => property('aa7075_t6', value, S12)),
    {
      command: 'define_material_record',
      params: {
        id: 'aa2024_t3',
        designation: '2024',
        temper: 'T3',
        productForm: 'sheet',
        specs: [{ body: 'SAE', id: 'AMS 4037' }],
        licence: 'vendor-catalogue',
        exportMarking: { regime: 'none' },
        color: '#c9d1d8',
      },
    },
    ...al2024.map((value) => property('aa2024_t3', value, S10)),
    property('aa2024_t3', { property: 'Ftu', value: 65, unit: 'ksi', basis: 'A' }, S8, sheetRange),
    property('aa2024_t3', { property: 'Fty', value: 49, unit: 'ksi', basis: 'A' }, S8, sheetRange),
    {
      command: 'create_material',
      params: {
        name: 'cfrp_twill',
        density: 1.55,
        densityUnit: 'g/cm^3',
        color: '#16181b',
        metalness: 0.2,
        roughness: 0.35,
        finish: 'carbon_twill',
        finishScale: 30,
        clearcoat: 1,
      },
    },
    {
      command: 'create_material',
      params: { name: 'al6061_anodized_red', density: 2.7, densityUnit: 'g/cm^3', color: '#a3312a', metalness: 0.7, roughness: 0.35 },
    },
    {
      command: 'create_material',
      params: { name: 'electrical_steel', density: 7.65, densityUnit: 'g/cm^3', color: '#3b3f46', metalness: 0.8, roughness: 0.4 },
    },
    {
      command: 'create_material',
      params: { name: 'nylon_white', density: 1.14, densityUnit: 'g/cm^3', color: '#ececec', metalness: 0, roughness: 0.45 },
    },
    {
      command: 'create_material',
      params: { name: 'pcb_potting_black', density: 1.8, densityUnit: 'g/cm^3', color: '#22262b', metalness: 0.1, roughness: 0.7 },
    },
    { command: 'assign_material', params: { materialName: 'cfrp_twill', entityIds: ['$wing', '$propeller'] } },
    { command: 'assign_material', params: { materialName: 'aa7075_t6', entityIds: ['$pylonDoubler', '$pylonFitting'] } },
    { command: 'assign_material', params: { materialName: 'al6061_anodized_red', entityIds: ['$bell'] } },
    { command: 'assign_material', params: { materialName: 'electrical_steel', entityIds: ['$stator'] } },
    { command: 'assign_material', params: { materialName: 'nylon_white', entityIds: ['$spinner'] } },
    { command: 'assign_material', params: { materialName: 'pcb_potting_black', entityIds: ['$esc'] } },
    { command: 'set_sheet_metal_material', params: { id: '$escBracket', materialName: 'aa2024_t3' } },
  ];
}

/** One row of four NAS6203-3 bolts on the fitting centreline (heads below the flange, MS21042L3 nuts in the wing cutout). */
function fastenerActions(design: FittingDesign, layout: FittingLayout): PlanAction[] {
  return [
    {
      command: 'insert_fastener_row',
      params: {
        family: 'NAS6203-6220',
        diameterDash: '3',
        nut: 'MS21042',
        washer: 'NAS1149',
        axis: [0, 0, 1],
        stackIds: ['$fitting', '$doubler'],
        from: [BOLT_X_FIRST, 0, layout.flangeBottom],
        to: [BOLT_X_LAST, 0, layout.flangeBottom],
        count: 4,
        edgeDistance: { value: design.halfWidth, unit: 'mm' },
        minEdgeDistance: { value: 9.5, unit: 'mm' },
        minPitch: { value: 19, unit: 'mm' },
        holeMode: 'cut_close_tolerance',
        holeDiameter: { value: 0.1905, unit: 'in' },
      },
      as: 'boltRow',
    },
    // The row re-cuts both plates at every stack: its affected list ends with the last stack's [fitting, doubler].
    {
      command: 'set_entity_name',
      params: { id: '$boltRow[18]', name: 'Pylon fitting (7075-T6, machined)', tags: ['airframe', 'primary-structure'] },
      as: 'pylonFitting',
    },
    {
      command: 'set_entity_name',
      params: { id: '$boltRow[19]', name: 'Pylon doubler (7075-T6)', tags: ['airframe', 'primary-structure'] },
      as: 'pylonDoubler',
    },
  ];
}

function layerActions(): PlanAction[] {
  const onLayer = (layer: string, ids: string[]): PlanAction[] =>
    ids.map((id) => ({ command: 'set_entity_layer', params: { entityId: id, layerId: layer } }));
  return [
    { command: 'add_layer', params: { name: 'Airframe', color: '#5b6b7a' }, as: 'layerAirframe' },
    { command: 'add_layer', params: { name: 'Propulsion', color: '#c8553d' }, as: 'layerPropulsion' },
    { command: 'add_layer', params: { name: 'Systems', color: '#4a90d9' }, as: 'layerSystems' },
    ...onLayer('$layerAirframe', ['$wing', '$pylonDoubler', '$pylonFitting']),
    ...onLayer('$layerPropulsion', ['$stator', '$bell', '$propeller', '$spinner']),
    ...onLayer('$layerSystems', ['$esc']),
    { command: 'set_sheet_metal_material', params: { id: '$escBracket', materialName: 'aa2024_t3', layerId: '$layerSystems' } },
  ];
}

/** 16x8 static coefficients (APC-class thin electric propeller, static test order of magnitude). */
const PROP_CT = 0.11;
const PROP_CP = 0.05;

function dynamicsActions(): PlanAction[] {
  return [
    {
      command: 'add_rigid_body',
      params: {
        id: 'airframe',
        name: 'Airframe (wing, pylon, stator)',
        entityIds: ['$wing', '$pylonDoubler', '$pylonFitting', '$stator', '$esc'],
        fixed: true,
      },
    },
    {
      command: 'add_rigid_body',
      params: { id: 'rotor', name: 'Rotor + propeller', entityIds: ['$bell', '$propeller', '$spinner'], massKg: 0.32 },
    },
    {
      command: 'add_body_joint',
      params: {
        id: 'prop_shaft',
        kind: 'revolute',
        child: 'rotor',
        parent: 'airframe',
        anchor: [PROP_X, 0, AXIS_Z],
        axis: [1, 0, 0],
        friction: 0.01,
        initialRpm: 600,
      },
    },
    {
      command: 'add_motor',
      params: {
        id: 'outrunner',
        joint: 'prop_shaft',
        kind: 'torque_curve',
        curve: [
          [0, 2.1],
          [3000, 2.0],
          [7000, 1.25],
          [9500, 0],
        ],
      },
    },
    {
      command: 'add_propeller',
      params: {
        id: 'prop_16x8',
        joint: 'prop_shaft',
        diameter: PROP_DIAMETER / 1000,
        thrustCoefficient: PROP_CT,
        powerCoefficient: PROP_CP,
        thrustDirection: [1, 0, 0],
      },
    },
  ];
}

/** Face pick points: the motor face of the web, the flange top (bonded to the doubler); off the y = 0 seam of the bored web. */
const webFace = (design: FittingDesign): number[] => [WEB_FRONT, Math.max(design.halfWidth, design.webHalfWidth) - 2, AXIS_Z + 35];
const flangeTopFace = (layout: FittingLayout): number[] => [-195, 15, layout.flangeTop];

/** Motor screws: tapped M4 on a 50 mm circle at 45° + k·90°, bore radius of the tap drill. */
const SCREW_CIRCLE_RADIUS = 25;
const SCREW_HOLE_RADIUS = 1.65;
const SCREW_ANGLES_DEG = [45, 135, 225, 315];

function structuralActions(design: FittingDesign, layout: FittingLayout): PlanAction[] {
  const webFacePoint = webFace(design);
  const [strutX, strutZ] = layout.strutEdge;
  // Limit torque reaction (stall 2.1 N·m x 1.25) shared by the four screws as tangential forces on their tapped hole walls.
  const screwTorque = SCREW_ANGLES_DEG.map((deg, index): PlanAction => {
    const angle = (deg * Math.PI) / 180;
    const radial = SCREW_CIRCLE_RADIUS + SCREW_HOLE_RADIUS;
    return {
      command: 'add_fea_load',
      params: {
        analysisId: '$staticCase',
        name: `Motor torque reaction, screw ${index + 1}`,
        kind: 'force',
        loadCase: 'LC1_thrust_10g',
        category: 'limit',
        target: {
          entityId: '$pylonFitting',
          facesNear: [
            [
              WEB_FRONT - design.web / 2,
              Math.round(radial * Math.cos(angle) * 1000) / 1000,
              Math.round((AXIS_Z + radial * Math.sin(angle)) * 1000) / 1000,
            ],
          ],
        },
        vector: [
          0,
          `=-torque_screw_N * ${Math.round(Math.sin(angle) * 1e6) / 1e6}`,
          `=torque_screw_N * ${Math.round(Math.cos(angle) * 1e6) / 1e6}`,
        ],
      },
    };
  });
  return [
    { command: 'set_parameter', params: { name: 'thrust_limit_N', expression: '60' } },
    { command: 'set_parameter', params: { name: 'inertia_limit_N', expression: '64' } },
    { command: 'set_parameter', params: { name: 'emergency_ultimate_N', expression: '58' } },
    { command: 'set_parameter', params: { name: 'torque_screw_N', expression: `2.1 * 1.25 * 1000 / (4 * ${SCREW_CIRCLE_RADIUS})` } },
    {
      command: 'create_analysis',
      params: {
        name: 'Pylon fitting: limit thrust + 10 g',
        analysisType: 'static',
        factors: {
          ultimate: 1.5,
          yield: 1,
          extra: [{ name: 'fitting factor', value: 1.15, justification: '14 CFR 25.625(a): fitting factor 1.15 on fittings' }],
        },
      },
      as: 'staticCase',
    },
    { command: 'set_part_idealization', params: { analysisId: '$staticCase', entityId: '$pylonFitting' } },
    {
      command: 'add_fea_constraint',
      params: {
        analysisId: '$staticCase',
        name: 'Flange bonded to doubler',
        kind: 'fixed',
        target: { entityId: '$pylonFitting', facesNear: [flangeTopFace(layout)] },
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$staticCase',
        name: 'Propeller thrust',
        kind: 'force',
        loadCase: 'LC1_thrust_10g',
        category: 'limit',
        target: { entityId: '$pylonFitting', facesNear: [webFacePoint] },
        vector: ['=thrust_limit_N', 0, 0],
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$staticCase',
        name: 'Motor + rotor inertia, 10 g down',
        kind: 'force',
        loadCase: 'LC1_thrust_10g',
        category: 'limit',
        target: { entityId: '$pylonFitting', facesNear: [webFacePoint] },
        vector: [0, 0, '=-inertia_limit_N'],
      },
    },
    ...screwTorque,
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$staticCase',
        name: 'Emergency landing, 9 g forward on the motor mass',
        kind: 'force',
        loadCase: 'LC2_emergency_9g',
        category: 'ultimate',
        target: { entityId: '$pylonFitting', facesNear: [webFacePoint] },
        vector: ['=-emergency_ultimate_N', 0, 0],
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$staticCase',
        name: 'Stiffness probe: 100 N down on the motor face',
        kind: 'force',
        loadCase: 'LC3_stiffness',
        category: 'limit',
        target: { entityId: '$pylonFitting', facesNear: [webFacePoint] },
        vector: [0, 0, -100],
      },
    },
    {
      command: 'set_mesh_controls',
      params: {
        analysisId: '$staticCase',
        order: 2,
        globalSize: 4,
        minSize: 0.8,
        refinements: [
          {
            target: {
              entityId: '$pylonFitting',
              edgesNear: [
                [strutX, design.halfWidth, strutZ],
                [strutX, -design.halfWidth, strutZ],
              ],
            },
            size: 2.5,
          },
        ],
      },
    },
    {
      command: 'add_result_probe',
      params: {
        analysisId: '$staticCase',
        name: 'Strut root (flange junction)',
        point: [layout.strutRoot[0], 0, layout.strutRoot[1]],
        quantity: 'von_mises',
      },
    },
    {
      command: 'add_result_probe',
      params: { analysisId: '$staticCase', name: 'Motor face deflection', point: [WEB_FRONT, 0, AXIS_Z - 20], quantity: 'u_mag' },
    },
    {
      command: 'add_result_probe',
      params: { analysisId: '$staticCase', name: 'Motor face vertical deflection', point: [WEB_FRONT, 0, AXIS_Z - 15], quantity: 'u_z' },
    },
  ];
}

const FILM_SOURCE = {
  citation: 'Owner estimate: forced convection in the propeller slipstream, flat plate at about 15 m/s',
  locator: 'Incropera, Fundamentals of Heat and Mass Transfer, 7th ed., Eq. 7.30 (order of magnitude)',
};

function thermalActions(design: FittingDesign, layout: FittingLayout): PlanAction[] {
  const flangeMid = (layout.flangeTop + layout.flangeBottom) / 2;
  return [
    { command: 'create_analysis', params: { name: 'Motor heat soak (hot-day climb)', analysisType: 'heat_steady' }, as: 'thermalCase' },
    { command: 'set_part_idealization', params: { analysisId: '$thermalCase', entityId: '$pylonFitting' } },
    { command: 'set_initial_temperature', params: { analysisId: '$thermalCase', value: 40, unit: 'degC' } },
    {
      command: 'add_thermal_bc',
      params: {
        analysisId: '$thermalCase',
        name: 'Motor stator heat into the web',
        kind: 'surface_flux',
        value: 2500,
        unit: 'W/m^2',
        target: { entityId: '$pylonFitting', facesNear: [webFace(design)] },
        source: { citation: 'Owner estimate: about 14 W of the 1.1 kW motor loss (87 % efficiency) conducted into the mount' },
      },
    },
    {
      command: 'add_thermal_bc',
      params: {
        analysisId: '$thermalCase',
        name: 'Wing structure sink',
        kind: 'temperature',
        value: 45,
        unit: 'degC',
        target: { entityId: '$pylonFitting', facesNear: [flangeTopFace(layout)] },
      },
    },
    {
      command: 'add_thermal_bc',
      params: {
        analysisId: '$thermalCase',
        name: 'Slipstream convection on the side faces',
        kind: 'film',
        filmCoefficient: { value: 30, unit: 'W/(m^2*K)' },
        sinkTemperature: { value: 40, unit: 'degC' },
        target: {
          entityId: '$pylonFitting',
          facesNear: [
            [-200, design.halfWidth, flangeMid],
            [-200, -design.halfWidth, flangeMid],
          ],
        },
        source: FILM_SOURCE,
      },
    },
    {
      command: 'add_temperature_limit',
      params: {
        analysisId: '$thermalCase',
        name: '7075-T6 over-ageing limit',
        entityId: '$pylonFitting',
        max: { value: 120, unit: 'degC' },
        source: { citation: 'Company rule: 7075-T6 structure kept below 121 degC (250 degF) to avoid over-ageing strength loss' },
      },
    },
    { command: 'set_mesh_controls', params: { analysisId: '$thermalCase', order: 2, globalSize: 4, minSize: 0.8 } },
    {
      command: 'add_result_probe',
      params: { analysisId: '$thermalCase', name: 'Web hot spot', point: [WEB_FRONT, 0, AXIS_Z + 30], quantity: 'temperature' },
    },
  ];
}

function documentationActions(): PlanAction[] {
  return [
    {
      command: 'set_project_info',
      params: { name: 'UAV propulsion pod', client: 'Sample project', author: 'llull', drawingNumber: 'UAV-PP-101', revision: 'B' },
    },
    {
      command: 'create_sheet',
      params: {
        name: 'Pylon fitting',
        paper: 'A3',
        title: 'PYLON FITTING - MOTOR MOUNT',
        partNumber: 'UAV-PP-101',
        revision: 'B',
        drawnBy: 'llull',
        date: '2026-10-17',
        projectionAngle: 'first',
        views: ['front', 'top', 'right', 'iso'],
        entityIds: ['$pylonFitting'],
      },
      as: 'fittingSheet',
    },
  ];
}

/** Ids are those minted on an empty document; `catalog` is the sample fastener catalogue file object. */
export function aerospaceStarterActions(catalog: unknown, design: FittingDesign = STARTER_FITTING): PlanAction[] {
  const layout = fittingLayout(design);
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'import_fastener_catalog', params: { catalog } },
    ...aerospaceGeometryActions(design),
    ...fastenerActions(design, layout),
    ...materialActions(),
    ...layerActions(),
    ...dynamicsActions(),
    ...structuralActions(design, layout),
    ...thermalActions(design, layout),
    ...documentationActions(),
    { command: 'fit_view', params: { direction: 'iso' } },
    // Front-left, just below the wing: the pod, propeller disc and fitting face the engineer.
    { command: 'set_camera', params: { target: [-40, 0, 262], azimuth: 2.2, polar: 1.75, distance: 950 } },
  ];
}
