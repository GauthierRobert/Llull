// Source census of an ASCII DXF, independent of llull's reader: counts records per section and type.
// Usage: node dxf_census.mjs <file.dxf>  ->  one JSON line { ver, entities, blocks, tables, objects }
// Used for the M3 baseline (sources.md) and as a cheap oracle next to ezdxf in the drawing gate (VC-XCH-102..104).
import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'latin1').split(/\r?\n/);
const pairs = [];
for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1]]);
const bump = (map, key) => (map[key] = (map[key] ?? 0) + 1);
const entities = {};
const blocks = {};
const tables = {};
const objects = {};
let section = null;
let ver = '';
for (let k = 0; k < pairs.length; k++) {
  const [code, value] = pairs[k];
  if (code === '0' && value === 'SECTION') {
    section = pairs[k + 1]?.[1].trim() ?? null;
    continue;
  }
  if (code === '9' && value.trim() === '$ACADVER') ver = pairs[k + 1]?.[1].trim() ?? '';
  if (code !== '0') continue;
  const type = value.trim();
  if (section === 'ENTITIES' && !['ENDSEC', 'SEQEND', 'VERTEX', 'EOF'].includes(type)) bump(entities, type);
  if (section === 'BLOCKS' && !['ENDBLK', 'ENDSEC', 'SEQEND', 'VERTEX'].includes(type)) bump(blocks, type);
  if (section === 'TABLES' && !['TABLE', 'ENDTAB', 'ENDSEC'].includes(type)) bump(tables, type);
  if (section === 'OBJECTS' && type !== 'ENDSEC') bump(objects, type);
}
process.stdout.write(JSON.stringify({ ver, entities, blocks, tables, objects }) + '\n');
