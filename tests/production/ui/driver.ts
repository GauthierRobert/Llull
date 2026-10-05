import type { ToolCall } from '../contract';
import { BuildingPanel } from './panel';
import { runViaPalette } from './palette';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Maps each scripted tool call to the control an engineer uses: Building panel forms (placement is
 * explicit: every form has its own Level selector). The command palette is the fallback when a
 * panel has no control for a call; every such detour is a `uiGap`. No document is injected and no
 * command is executed in the page.
 */

const GAP = {
  levelElevation:
    "Levels list 'Add level' form has only name + height (no elevation): levels can only stack on the top one.",
  historyEdit:
    'No panel edits a history step: the only identity-preserving change of anything but an equipment is the command palette edit_step_params with hand-typed JSON and a step id.',
  unmapped: (tool: string): string =>
    `No panel control for ${tool}: reachable only through the command palette.`,
} as const;

const asNumbers = (value: unknown): number[] => (Array.isArray(value) ? value.map(Number) : []);
const text = (value: unknown): string => String(value);
const degrees = (radians: number): string => String((radians * 180) / Math.PI);
const levelOf = (args: Record<string, unknown>): Record<string, string> =>
  typeof args['levelId'] === 'string' ? { levelId: args['levelId'] } : {};
const route = (points: unknown): string =>
  (Array.isArray(points) ? points : []).map((point) => asNumbers(point).join(',')).join('; ');

export class UiDriver {
  readonly gaps = new Set<string>();
  /** Tool calls done through a panel form vs the command palette. */
  readonly steps = { panel: 0, palette: 0 };
  private readonly panel: BuildingPanel;
  private levelTop = 0;

  constructor(private readonly session: UiSession) {
    this.panel = new BuildingPanel(session);
  }

  get uiGaps(): string[] {
    return [...this.gaps];
  }

  /** Levels already in the opened project (a revision starts from an issued model). */
  startFromProject(levels: ReadonlyArray<{ elevation: number; height: number }>): void {
    this.levelTop = Math.max(0, ...levels.map((level) => level.elevation + level.height));
  }

  async perform(call: ToolCall): Promise<string> {
    const paletteBefore = this.steps.palette;
    const started = Date.now();
    const summary = await this.route(call);
    if (this.steps.palette === paletteBefore) this.steps.panel += 1;
    if (process.env['PRODUCTION_TRACE'] !== undefined) {
      process.stderr.write(`[ui ${Date.now() - started}ms] ${call.tool}: ${summary}\n`);
    }
    return summary;
  }

  private palette(command: string, args: Record<string, unknown>): Promise<string> {
    this.steps.palette += 1;
    return runViaPalette(this.session, command, args);
  }

  private async route(call: ToolCall): Promise<string> {
    const args = call.args;
    switch (call.tool) {
      case 'set_project_info':
        return this.panel.setProjectInfo(
          Object.fromEntries(Object.entries(args).map(([key, value]) => [key, text(value)])),
        );
      case 'add_level':
        return this.addLevel(args);
      case 'add_grid_system':
        return this.panel.applyTool('grid', {
          xSpacings: asNumbers(args['xSpacings']).join(', '),
          ySpacings: asNumbers(args['ySpacings']).join(', '),
        });
      case 'add_steel_member': {
        const [start, end] = [asNumbers(args['start']), asNumbers(args['end'])];
        return this.panel.applyTool(
          'member',
          {
            x1: text(start[0]),
            y1: text(start[1]),
            z1: text(start[2]),
            x2: text(end[0]),
            y2: text(end[1]),
            z2: text(end[2]),
          },
          { role: text(args['role']), profile: text(args['profile']), ...levelOf(args) },
        );
      }
      case 'add_slab':
        return this.addSlab(args);
      case 'add_equipment': {
        const [location, size] = [asNumbers(args['location']), asNumbers(args['size'])];
        return this.panel.applyTool(
          'equipment',
          {
            mark: text(args['mark'] ?? ''),
            name: text(args['name']),
            x: text(location[0]),
            y: text(location[1]),
            length: text(size[0]),
            width: text(size[1]),
            height: text(size[2]),
            weight: text(args['weight'] ?? ''),
            clearance: text(args['clearance']),
          },
          levelOf(args),
        );
      }
      case 'add_slab_opening':
        return this.addSlabOpening(args);
      case 'add_stair': {
        const start = asNumbers(args['start']);
        return this.panel.applyTool(
          'stair',
          {
            x: text(start[0]),
            y: text(start[1]),
            direction: degrees(Number(args['angle'] ?? 0)),
            width: text(args['width']),
          },
          levelOf(args),
        );
      }
      case 'add_pipe_run':
        return this.panel.applyTool(
          'pipe',
          {
            points: route(args['points']),
            line: text(args['line'] ?? ''),
            diameter: text(args['diameter'] ?? ''),
            from: text(args['from'] ?? ''),
            to: text(args['to'] ?? ''),
            service: text(args['service']),
          },
          { dn: text(args['dn'] ?? ''), ...levelOf(args) },
        );
      case 'add_cable_tray':
        return this.panel.applyTool(
          'tray',
          {
            points: route(args['points']),
            width: text(args['width']),
            height: text(args['height']),
            system: text(args['system']),
          },
          levelOf(args),
        );
      case 'check_clashes':
        return this.panel.checkClashes();
      case 'edit_step_params':
        return this.editStep(args);
      default:
        this.gaps.add(GAP.unmapped(call.tool));
        return this.palette(call.tool, args);
    }
  }

  /**
   * A change to an equipment step (the revision's uprated extractor) is made in the equipment
   * editor (`update_equipment`); the editor sends only the fields whose text changed.
   */
  private async editStep(args: Record<string, unknown>): Promise<string> {
    const params = args['params'];
    const step = typeof params === 'object' && params !== null ? params : {};
    const record = step as Record<string, unknown>;
    if (typeof record['mark'] !== 'string' || record['size'] === undefined) {
      this.gaps.add(GAP.historyEdit);
      return this.palette('edit_step_params', args);
    }
    const [location, size] = [asNumbers(record['location']), asNumbers(record['size'])];
    return this.panel.editEquipment(record['mark'], {
      name: text(record['name']),
      x: text(location[0]),
      y: text(location[1]),
      length: text(size[0]),
      width: text(size[1]),
      height: text(size[2]),
      weight: text(record['weight']),
      clearance: text(record['clearance']),
    });
  }

  private async addLevel(args: Record<string, unknown>): Promise<string> {
    if (args['elevation'] !== undefined && Number(args['elevation']) !== this.levelTop) {
      this.gaps.add(GAP.levelElevation);
    }
    const height = Number(args['height']);
    const summary = await this.panel.addLevel(text(args['name']), height);
    this.levelTop = Number(args['elevation'] ?? this.levelTop) + height;
    return summary;
  }

  /** Gratings and floors are drawn as the rectangle given by two opposite corners. */
  private async addSlab(args: Record<string, unknown>): Promise<string> {
    const corners = (Array.isArray(args['boundary']) ? args['boundary'] : []).map(asNumbers);
    const [first, , third] = corners;
    return this.panel.applyTool(
      'slab',
      {
        x1: text(first?.[0]),
        y1: text(first?.[1]),
        x2: text(third?.[0]),
        y2: text(third?.[1]),
        thickness: text(args['thickness']),
        material: text(args['material'] ?? ''),
      },
      { source: 'rectangle', ...levelOf(args) },
    );
  }

  private async addSlabOpening(args: Record<string, unknown>): Promise<string> {
    if (typeof args['stairId'] === 'string') {
      return this.panel.applyTool('slabOpening', {}, { source: 'stair', stairId: args['stairId'] });
    }
    const corners = (Array.isArray(args['boundary']) ? args['boundary'] : []).map(asNumbers);
    const [first, , third] = corners;
    return this.panel.applyTool(
      'slabOpening',
      {
        x1: text(first?.[0]),
        y1: text(first?.[1]),
        x2: text(third?.[0]),
        y2: text(third?.[1]),
      },
      { source: 'rectangle', slabId: text(args['slabId']) },
    );
  }
}
