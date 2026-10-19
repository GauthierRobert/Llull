#!/usr/bin/env node
/**
 * Developer stand-in for GNU dlltool on Windows machines without MSVC and without MinGW binutils (the `x86_64-pc-windows-gnu` rustup
 * toolchain ships dlltool but not the assembler it spawns). wgpu's Windows dependencies (`windows-link`) import with raw-dylib, so any
 * build or test that enables wgpu (`npm run native:check`, `--features gpu`) needs import libraries. This writes the same layout
 * dlltool does for x86-64 (`--temp-prefix` members `<p>_h.o` head with the import descriptor, `<p>_sNNNNN.o` one jump stub + IAT / ILT /
 * hint-name per symbol, `<p>_t.o` terminators and DLL name) as COFF objects, in a GNU archive with a symbol index. Only the subset rustc
 * passes: -d <def> -D <dll> -l <out> -m i386:x86-64 -f --64 --no-leading-underscore --temp-prefix <p>. Not a build dependency of llull.
 * Use (PowerShell, GNU toolchain):
 *   $env:RUSTUP_TOOLCHAIN = '1.97.0-x86_64-pc-windows-gnu'
 *   $env:PATH = "<rustup>\toolchains\1.97.0-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;$env:PATH"
 *   $env:RUSTFLAGS = "-C dlltool=<repo>\solver\scripts\dlltool-shim\dlltool.cmd"
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const def = readFileSync(value('-d'), 'utf8');
const dll = value('-D');
const out = value('-l');
// Every generated library gets its own head / tail and member names: several crates import the same DLL, and a shared head would leave
// one library's IAT entries outside any import descriptor (unresolved at load).
const unique = createHash('sha256').update(out).digest('hex').slice(0, 10);
const prefix = `${args.includes('--temp-prefix') ? value('--temp-prefix') : dll}_${unique}`;
const tag = `${dll.replace(/[^A-Za-z0-9]/g, '_')}_${unique}`;

const exports = [];
let inExports = false;
for (const raw of def.split(/\r?\n/)) {
  const line = raw.trim();
  if (line === '' || line.startsWith(';')) continue;
  if (/^EXPORTS$/i.test(line)) {
    inExports = true;
    continue;
  }
  if (/^(LIBRARY|NAME)\b/i.test(line) || !inExports) continue;
  const m = /^("?)([^\s"=@]+)\1(?:\s*==\s*(\S+))?(?:\s*=\s*(\S+))?(?:\s*@\s*(\d+))?(\s+NONAME)?(\s+DATA)?/.exec(line);
  if (!m) throw new Error(`dlltool shim: cannot parse '${line}'`);
  exports.push({ name: m[2], importName: m[3] ?? m[2], ordinal: m[5] ? Number(m[5]) : 0, noname: !!m[6], data: !!m[7] });
}

const ADDR32NB = 3;
const REL32 = 4;
const STATIC = 3;
const EXTERNAL = 2;
const DATA_RW = 0x40 | 0x40000000 | 0x80000000;
const ALIGN = { 2: 0x00200000, 4: 0x00300000, 8: 0x00400000 };
const TEXT = 0x20 | 0x20000000 | 0x40000000 | ALIGN[4];

/**
 * One COFF object. sections: [{ name, data, flags, relocs: [{ offset, symbol (name), type }] }]; symbols: [{ name, section (1-based, 0
 * undefined), cls, type }]. Section symbols are added first, one per section, named like the section.
 */
function coff(sections, symbols) {
  const all = [...sections.map((s, i) => ({ name: s.name, section: i + 1, cls: STATIC, type: 0 })), ...symbols];
  const index = new Map(all.map((s, i) => [s.name, i]));
  const headerSize = 20 + 40 * sections.length;
  let cursor = headerSize;
  const layout = sections.map((s) => {
    const dataAt = s.data.length > 0 ? cursor : 0;
    cursor += s.data.length;
    const relocAt = s.relocs.length > 0 ? cursor : 0;
    cursor += 10 * s.relocs.length;
    return { dataAt, relocAt };
  });
  const symtabAt = cursor;
  const strings = [];
  let stringSize = 4;
  const symbolBytes = Buffer.alloc(18 * all.length);
  all.forEach((s, i) => {
    const at = i * 18;
    if (Buffer.byteLength(s.name, 'latin1') <= 8) symbolBytes.write(s.name, at, 'latin1');
    else {
      symbolBytes.writeUInt32LE(0, at);
      symbolBytes.writeUInt32LE(stringSize, at + 4);
      strings.push(Buffer.from(`${s.name}\0`, 'latin1'));
      stringSize += Buffer.byteLength(s.name, 'latin1') + 1;
    }
    symbolBytes.writeUInt32LE(0, at + 8);
    symbolBytes.writeInt16LE(s.section, at + 12);
    symbolBytes.writeUInt16LE(s.type, at + 14);
    symbolBytes.writeUInt8(s.cls, at + 16);
    symbolBytes.writeUInt8(0, at + 17);
  });
  const stringTable = Buffer.concat([Buffer.alloc(4), ...strings]);
  stringTable.writeUInt32LE(stringSize, 0);
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0x8664, 0);
  header.writeUInt16LE(sections.length, 2);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(symtabAt, 8);
  header.writeUInt32LE(all.length, 12);
  const body = [];
  sections.forEach((s, i) => {
    const at = 20 + 40 * i;
    header.write(s.name, at, 'latin1');
    header.writeUInt32LE(s.data.length, at + 16);
    header.writeUInt32LE(layout[i].dataAt, at + 20);
    header.writeUInt32LE(layout[i].relocAt, at + 24);
    header.writeUInt16LE(s.relocs.length, at + 32);
    header.writeUInt32LE(s.flags >>> 0, at + 36);
    body.push(s.data);
    const relocs = Buffer.alloc(10 * s.relocs.length);
    s.relocs.forEach((r, k) => {
      const symbol = index.get(r.symbol);
      if (symbol === undefined) throw new Error(`dlltool shim: unknown symbol ${r.symbol}`);
      relocs.writeUInt32LE(r.offset, k * 10);
      relocs.writeUInt32LE(symbol, k * 10 + 4);
      relocs.writeUInt16LE(r.type, k * 10 + 8);
    });
    body.push(relocs);
  });
  return Buffer.concat([header, ...body, symbolBytes, stringTable]);
}

const headSymbol = `_head_${tag}`;
const inameSymbol = `${tag}_iname`;

const head = coff(
  [
    {
      name: '.idata$2',
      data: Buffer.alloc(20),
      flags: DATA_RW | ALIGN[4],
      relocs: [
        { offset: 0, symbol: '.idata$4', type: ADDR32NB },
        { offset: 12, symbol: inameSymbol, type: ADDR32NB },
        { offset: 16, symbol: '.idata$5', type: ADDR32NB },
      ],
    },
    { name: '.idata$5', data: Buffer.alloc(0), flags: DATA_RW | ALIGN[8], relocs: [] },
    { name: '.idata$4', data: Buffer.alloc(0), flags: DATA_RW | ALIGN[8], relocs: [] },
  ],
  [
    { name: headSymbol, section: 1, cls: EXTERNAL, type: 0 },
    { name: inameSymbol, section: 0, cls: EXTERNAL, type: 0 },
  ],
);

function stub(e) {
  const thunk = Buffer.alloc(8);
  if (e.noname) thunk.writeBigUInt64LE((1n << 63n) | BigInt(e.ordinal));
  const hintName = Buffer.concat([Buffer.alloc(2), Buffer.from(`${e.importName}\0`, 'latin1')]);
  hintName.writeUInt16LE(e.ordinal & 0xffff, 0);
  const named = e.noname ? [] : [{ offset: 0, symbol: '.idata$6', type: ADDR32NB }];
  const sections = [
    ...(e.data
      ? []
      : [
          {
            name: '.text',
            data: Buffer.from([0xff, 0x25, 0, 0, 0, 0, 0x90, 0x90]),
            flags: TEXT,
            relocs: [{ offset: 2, symbol: `__imp_${e.name}`, type: REL32 }],
          },
        ]),
    { name: '.idata$7', data: Buffer.alloc(4), flags: DATA_RW | ALIGN[4], relocs: [{ offset: 0, symbol: headSymbol, type: ADDR32NB }] },
    { name: '.idata$5', data: Buffer.from(thunk), flags: DATA_RW | ALIGN[8], relocs: named },
    { name: '.idata$4', data: Buffer.from(thunk), flags: DATA_RW | ALIGN[8], relocs: named },
    ...(e.noname
      ? []
      : [
          {
            name: '.idata$6',
            data: hintName.length % 2 ? Buffer.concat([hintName, Buffer.alloc(1)]) : hintName,
            flags: DATA_RW | ALIGN[2],
            relocs: [],
          },
        ]),
  ];
  const sectionNumber = (name) => sections.findIndex((s) => s.name === name) + 1;
  return coff(sections, [
    ...(e.data ? [] : [{ name: e.name, section: sectionNumber('.text'), cls: EXTERNAL, type: 0x20 }]),
    { name: `__imp_${e.name}`, section: sectionNumber('.idata$5'), cls: EXTERNAL, type: 0 },
    { name: headSymbol, section: 0, cls: EXTERNAL, type: 0 },
  ]);
}

const dllBytes = Buffer.from(`${dll}\0`, 'latin1');
const tail = coff(
  [
    { name: '.idata$4', data: Buffer.alloc(8), flags: DATA_RW | ALIGN[8], relocs: [] },
    { name: '.idata$5', data: Buffer.alloc(8), flags: DATA_RW | ALIGN[8], relocs: [] },
    {
      name: '.idata$7',
      data: dllBytes.length % 2 ? Buffer.concat([dllBytes, Buffer.alloc(1)]) : dllBytes,
      flags: DATA_RW | ALIGN[4],
      relocs: [],
    },
  ],
  [{ name: inameSymbol, section: 3, cls: EXTERNAL, type: 0 }],
);

const members = [
  { name: `${prefix}_h.o`, data: head, symbols: [headSymbol] },
  ...exports.map((e, i) => ({
    name: `${prefix}_s${String(i).padStart(5, '0')}.o`,
    data: stub(e),
    symbols: e.data ? [`__imp_${e.name}`] : [e.name, `__imp_${e.name}`],
  })),
  { name: `${prefix}_t.o`, data: tail, symbols: [inameSymbol] },
];

function memberHeader(name, size) {
  const h = Buffer.alloc(60, 0x20);
  h.write(name, 0, 'latin1');
  h.write('0', 16, 'latin1');
  h.write('0', 28, 'latin1');
  h.write('0', 34, 'latin1');
  h.write('644', 40, 'latin1');
  h.write(String(size), 48, 'latin1');
  h.write('`\n', 58, 'latin1');
  return h;
}
const pad = (b) => (b.length % 2 === 0 ? b : Buffer.concat([b, Buffer.from('\n')]));

const longNameOffsets = [];
let longNames = '';
for (const m of members) {
  longNameOffsets.push(longNames.length);
  longNames += `${m.name}/\n`;
}
const longBytes = Buffer.from(longNames, 'latin1');
const symbols = members.flatMap((m, i) => m.symbols.map((s) => ({ s, i })));
const nameBytes = Buffer.concat(symbols.map(({ s }) => Buffer.from(`${s}\0`, 'latin1')));
const armapSize = 4 + 4 * symbols.length + nameBytes.length;
let offset = 8 + 60 + armapSize + (armapSize % 2) + 60 + longBytes.length + (longBytes.length % 2);
const memberOffsets = members.map((m) => {
  const at = offset;
  offset += 60 + m.data.length + (m.data.length % 2);
  return at;
});
const armap = Buffer.alloc(armapSize);
armap.writeUInt32BE(symbols.length, 0);
symbols.forEach(({ i }, k) => armap.writeUInt32BE(memberOffsets[i], 4 + 4 * k));
nameBytes.copy(armap, 4 + 4 * symbols.length);

const parts = [
  Buffer.from('!<arch>\n', 'latin1'),
  memberHeader('/', armapSize),
  pad(armap),
  memberHeader('//', longBytes.length),
  pad(longBytes),
];
members.forEach((m, i) => parts.push(memberHeader(`/${longNameOffsets[i]}`, m.data.length), pad(m.data)));
writeFileSync(out, Buffer.concat(parts));
