/* eslint-disable no-console -- runnable CLI demo; console output is its product. */
/**
 * @layer server/examples
 *
 * End-to-end MCP demo: an external agent designs a complete precision-machining plant through
 * the llull MCP server ONLY (tools/call over Streamable HTTP) — no direct command imports.
 *
 *   two-span steel hall + 16 t crane, office annex with layered walls, curved entrance lobby,
 *   machines, utilities, clash check & fix, costing, drawings, IFC / DXF.
 *
 * Run (server first):  npm --prefix server run build && npm --prefix server start
 *                      npx --prefix server tsx server/examples/factory-demo.mts [outDir]
 * Env: MCP_URL (default http://localhost:3001/mcp), MCP_AUTH_TOKEN.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const url = new URL(process.env['MCP_URL'] ?? 'http://localhost:3001/mcp');
const token = process.env['MCP_AUTH_TOKEN'];
const outDir = process.argv[2] ?? 'factory-demo-output';
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries on HTTP 429 (the server allows 60 MCP requests per minute by default). */
async function politely<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if ((error as { code?: number }).code !== 429 || attempt > 15) throw error;
      await sleep(5000);
    }
  }
}

async function main(): Promise<void> {
  const client = new Client({ name: 'llull-factory-demo', version: '1.0.0' });
  await politely(() =>
    client.connect(
      // Cast: the concrete `sessionId` getter is `string | undefined` (exactOptionalPropertyTypes).
      new StreamableHTTPClientTransport(url, {
        ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
      }) as Transport,
    ),
  );

  type Data = Record<string, unknown>;
  let calls = 0;

  /** tools/call; prints the summary; throws when the command refused. */
  async function call(name: string, args: Data = {}, { quiet = false } = {}): Promise<Data> {
    calls += 1;
    await sleep(1050); // stay under the default rate limit
    const result = await politely(() => client.callTool({ name, arguments: args }));
    const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string }>;
    const summary = content.find((block) => block.type === 'text')?.text ?? '';
    if (!quiet) console.log(`• ${name}: ${summary.split('\n')[0]?.slice(0, 220)}`);
    if (result.isError || /\bfailed\b|refused/.test(summary)) {
      throw new Error(`${name} → ${summary}`);
    }
    const image = content.find((block) => block.type === 'image');
    const affectedText = content.find((block) => block.text?.startsWith('Affected entity ids: '));
    const affected = affectedText?.text?.slice('Affected entity ids: '.length).split(', ') ?? [];
    const data = { ...((result.structuredContent ?? {}) as Data), affected };
    return image?.data ? { ...data, png: image.data } : data;
  }

  const ids = (data: Data): string[] => (data['elementIds'] as string[] | undefined) ?? [];

  // ── 1. Project ────────────────────────────────────────────────────────────────
  await call('clear_document');
  await call('set_project_info', {
    name: 'Precision Machining Plant — Hall B',
    client: 'Atelier Mécanique SA',
    address: 'Zone industrielle Nord, 4100 Seraing',
    author: 'llull MCP agent',
    drawingNumber: 'PMP-B-100',
    revision: 'A',
    date: '2026-10-01',
  });
  await call('add_level', { name: 'Ground floor', elevation: 0, height: 4000 });
  await call('add_level', {
    name: 'Office first floor',
    elevation: 4000,
    height: 3500,
    makeActive: false,
  });

  // ── 2. Two-span portal-frame hall with a 16 t crane in each span ──────────────
  const hall = await call('add_portal_frame_building', {
    origin: [0, 0],
    spans: [24000, 24000],
    length: 60000,
    baySpacing: 6000,
    eaveHeight: 9000,
    roofPitch: 6,
    columnProfile: 'HEA500',
    rafterProfile: 'IPE500',
    crane: { capacity: 16, railHeight: 7000 },
  });

  // ── 3. Office annex west of the hall: 2 storeys, insulated cavity walls ────────
  const annex = await call('draw_walls', {
    points: [
      [-13000, 6000],
      [-1000, 6000],
      [-1000, 24000],
      [-13000, 24000],
    ],
    closed: true,
    thickness: 300,
    height: 4000,
    material: 'masonry',
  });
  const perimeter = (annex['wallIds'] as string[] | undefined) ?? [];
  await call('set_wall_layers', {
    wallIds: perimeter,
    layers: [
      { material: 'brick', thickness: 100, function: 'finish' },
      { material: 'air', thickness: 40, function: 'air' },
      { material: 'mineral-wool', thickness: 140, function: 'insulation' },
      { material: 'concrete-block', thickness: 190, function: 'structure' },
      { material: 'gypsum', thickness: 15, function: 'finish' },
    ],
  });
  const corridor = await call('add_wall', {
    start: [-13000, 15000],
    end: [-1000, 15000],
    thickness: 120,
    material: 'gypsum',
  });
  const partition = await call('add_wall', {
    start: [-7000, 6000],
    end: [-7000, 15000],
    thickness: 120,
    material: 'gypsum',
  });
  /** New element id = first affected id (building commands list element ids first). */
  const first = (data: Data): string => (data['affected'] as string[])[0] ?? '';
  const corridorId = first(corridor);
  const partitionId = first(partition);
  const [south, east, north, west] = perimeter;
  await call('add_door', { wallId: east, offset: 3000, width: 1000 }); // to the hall
  await call('add_door', { wallId: corridorId, offset: 3000, width: 900 });
  await call('add_door', { wallId: corridorId, offset: 9000, width: 900, swing: 'right' });
  await call('add_door', { wallId: partitionId, offset: 7000, width: 900 });
  for (const [wall, offsets] of [
    [north, [2000, 5000, 8000, 10500]],
    [west, [3000, 9000, 15000]],
    [south, [2000, 9500]],
  ] as const) {
    for (const offset of offsets) {
      await call(
        'add_window',
        { wallId: wall, offset, width: 1500, height: 1400, sillHeight: 900 },
        { quiet: true },
      );
    }
  }
  console.log('• add_window ×9 (north, west, south façades)');
  await call('add_slab', {
    wallIds: perimeter,
    wallFace: 'outer',
    role: 'floor',
    thickness: 250,
    offset: 0,
  });
  await call('copy_level_elements', {
    sourceLevelId: 'level-1',
    targetLevelIds: ['level-2'],
    categories: ['wall', 'slab', 'door', 'window'],
  });
  const stair = await call('add_stair', {
    start: [-12500, 16000],
    angle: 0,
    width: 1200,
    levelId: 'level-1',
  });
  await call('add_slab_opening', { stairId: stair['elementId'] as string, margin: 100 });
  await call('add_slab', {
    boundary: [
      [-13150, 5850],
      [-850, 5850],
      [-850, 24150],
      [-13150, 24150],
    ],
    role: 'roof',
    thickness: 300,
    offset: 3500,
    levelId: 'level-2',
  });
  for (const [name, number, boundary] of [
    [
      'Reception',
      '001',
      [
        [-12850, 6150],
        [-7060, 6150],
        [-7060, 14940],
        [-12850, 14940],
      ],
    ],
    [
      'Quality lab',
      '002',
      [
        [-6940, 6150],
        [-1150, 6150],
        [-1150, 14940],
        [-6940, 14940],
      ],
    ],
    [
      'Locker rooms',
      '003',
      [
        [-12850, 15060],
        [-1150, 15060],
        [-1150, 23850],
        [-12850, 23850],
      ],
    ],
  ] as const) {
    await call('add_room', { name, number, boundary, levelId: 'level-1' }, { quiet: true });
  }
  console.log('• add_room ×3 (reception, quality lab, locker rooms)');

  // ── 4. Curved glazed entrance lobby on the south side of the annex ────────────
  const lobby = await call('add_curved_wall', {
    start: [-13000, 6000],
    through: [-7000, 1500],
    end: [-1000, 6000],
    thickness: 250,
    height: 4000,
    material: 'concrete',
    levelId: 'level-1',
  });
  await call('add_door', { wallId: lobby['elementId'] as string, width: 2000, height: 2400 });
  for (const at of [
    [-11000, 3200],
    [-3000, 3200],
  ] as const) {
    await call('add_window', {
      wallId: lobby['elementId'] as string,
      at,
      width: 2400,
      height: 2400,
      sillHeight: 300,
    });
  }

  // ── 5. Process: machines, utilities ───────────────────────────────────────────
  const machines = [
    ['5-axis machining centre', [8000, 12000], [6500, 3500, 3200], 18000],
    ['5-axis machining centre', [8000, 24000], [6500, 3500, 3200], 18000],
    ['CNC turning centre', [16000, 12000], [5000, 2400, 2200], 9500],
    ['CNC turning centre', [16000, 24000], [5000, 2400, 2200], 9500],
    ['Coordinate measuring machine', [36000, 12000], [4000, 3000, 3000], 6000],
    ['Hydraulic press 400 t', [32000, 36000], [4500, 3500, 5500], 42000],
    ['Washing line', [40000, 48000], [9000, 2500, 2800], 7000],
    ['Air compressor', [2000, 56000], [2600, 1600, 1900], 2200],
  ] as const;
  for (const [name, location, size, weight] of machines) {
    await call('add_equipment', { name, location, size, weight, clearance: 800 }, { quiet: true });
  }
  console.log(`• add_equipment ×${machines.length}`);
  await call('add_pipe_run', {
    points: [
      [2000, 56000, 1000],
      [2000, 56000, 6000],
      [2000, 4000, 6000],
      [44000, 4000, 6000],
    ],
    diameter: 88.9,
    service: 'compressed air',
  });
  await call('add_pipe_run', {
    points: [
      [8000, 4000, 6000],
      [8000, 12000, 6000],
      [8000, 12000, 3700],
    ],
    diameter: 33.7,
    service: 'compressed air',
  });
  await call('add_pipe_run', {
    points: [
      [12000, 2000, 5500],
      [12000, 58000, 5500],
    ],
    diameter: 114.3,
    service: 'cooling water',
  });
  await call('add_cable_tray', {
    points: [
      [-500, 30000, 6500],
      [36000, 30000, 6500],
    ],
    width: 600,
    height: 100,
    system: 'power',
  });
  await call('add_cable_tray', {
    points: [
      [20000, 2000, 6500],
      [20000, 58000, 6500],
    ],
    width: 300,
    height: 60,
    system: 'data',
  });

  // ── 6. Coordination: clash check, re-route, re-check ──────────────────────────
  const clashes = (await call('check_clashes'))['clashes'] as Array<{ a: string; b: string }>;
  // The first tray layout ran along a frame line (through the columns and crane brackets) and
  // crossed the data tray at the same height: re-route both mid-bay, on two tiers below the
  // crane brackets. The compressor sits inside a column's clearance: move it with its feed line.
  await call('delete_building_element', { elementIds: ['tray-1', 'tray-2'] });
  await call('add_cable_tray', {
    points: [
      [-500, 27000, 5200],
      [36000, 27000, 5200],
    ],
    width: 600,
    height: 100,
    system: 'power',
  });
  await call('add_cable_tray', {
    points: [
      [21000, 2000, 5600],
      [21000, 58000, 5600],
    ],
    width: 300,
    height: 60,
    system: 'data',
  });
  await call('move_building_element', { elementIds: ['equipment-8', 'pipe-1'], delta: [2500, 0] });
  const recheck = (await call('check_clashes'))['clashes'] as unknown[];

  // ── 7. Quantities & cost ──────────────────────────────────────────────────────
  await call('set_cost_rates', {
    currency: 'EUR',
    rates: {
      'member.*.kg': 2.9,
      'plate.*.kg': 4.2,
      'connection.*.kg': 4.5,
      'plate.anchor M24.ea': 38,
      'connection.bolt M20.ea': 6.5,
      'footing.*.m3': 210,
      'slab-floor.*.m3': 185,
      'slab-roof.*.m3': 230,
      'panel-roof.*.m2': 64,
      'panel-wall.*.m2': 58,
      'wall.brick.m2': 95,
      'wall.mineral-wool.m2': 28,
      'wall.concrete-block.m3': 260,
      'wall.gypsum.m2': 32,
      'wall.air.m2': 0,
      'wall.*.m': 0,
      'wall.concrete.m3': 320,
      'door.*.ea': 850,
      'window.*.ea': 1100,
      'pipe.*.m': 85,
      'tray.*.m': 60,
      'stair.*.ea': 9500,
    },
  });
  const estimate = await call('estimate_cost');
  const takeoff = await call('quantity_takeoff', {}, { quiet: true });
  writeFileSync(join(outDir, 'quantity-takeoff.csv'), String(takeoff['csv'] ?? ''));
  writeFileSync(join(outDir, 'cost-estimate.csv'), String(estimate['csv'] ?? ''));
  for (const kind of ['member', 'connection', 'plate', 'door', 'window', 'room', 'equipment']) {
    const schedule = await call('building_schedule', { kind }, { quiet: true });
    writeFileSync(join(outDir, `schedule-${kind}.csv`), String(schedule['csv'] ?? ''));
  }
  console.log(
    '• building_schedule ×7 (members, connections, base plates, doors, windows, rooms, equipment)',
  );

  // ── 8. Deliverables ───────────────────────────────────────────────────────────
  const save = (name: string, text: unknown): void =>
    writeFileSync(join(outDir, name), String(text ?? ''));
  /** Drawing tools return their sheet as a PNG image block (the server rasterises SVG results). */
  const saveImage = (name: string, data: Data): void => {
    if (typeof data['png'] === 'string')
      writeFileSync(join(outDir, name), Buffer.from(data['png'], 'base64'));
  };
  saveImage(
    'ground-floor-plan.png',
    await call('export_plan_sheet', { levelId: 'level-1', paper: 'A1', scale: 200 }),
  );
  saveImage(
    'first-floor-plan.png',
    await call('export_plan_sheet', { levelId: 'level-2', paper: 'A3', scale: 100 }),
  );
  saveImage(
    'south-elevation.png',
    await call('export_elevation_sheet', { direction: 'south', paper: 'A1' }),
  );
  saveImage(
    'frame-elevation-east.png',
    await call('export_elevation_sheet', { direction: 'east', exclude: ['panel'], paper: 'A1' }),
  );
  saveImage(
    'section-frame-3.png',
    await call('export_elevation_sheet', {
      direction: 'south',
      cutAt: 12000,
      exclude: ['equipment'],
      paper: 'A1',
    }),
  );
  save('plant.ifc', (await call('export_ifc'))['ifc']);
  save('ground-floor.dxf', (await call('export_dxf', { levelId: 'level-1' }))['dxf']);
  for (const view of ['iso', 'top']) {
    saveImage(`render-${view}.png`, await call('render_view', { view, width: 1600, height: 1000 }));
  }
  await call('fit_view', { direction: 'iso' });

  console.log(
    `\n${calls} MCP tool calls · ${ids(hall).length} hall elements · ${clashes.length} clash(es) found, ` +
      `${recheck.length} after re-routing · output in ${outDir}`,
  );
  await client.close();
}

void main();
