/* eslint-disable no-console -- this is a runnable CLI verification script; console output is its product. */
/**
 * @layer server/examples
 *
 * Smoke-test for the GET /export/stl download endpoint.
 *
 * What it verifies:
 *   1. POST /command add_box  — seed the live document with one 3D entity.
 *   2. GET  /export/stl       — ASCII download; check status + body starts with 'solid '.
 *   3. GET  /export/stl?format=binary  — binary download; check status + byte length framing.
 *   4. GET  /export/stl?name=mypart   — custom name reflected in Content-Disposition.
 *
 * Run (server must be started first — `npm --prefix server run dev`):
 *   npx tsx server/examples/verify-export-download.ts
 *
 * Optional env vars:
 *   SERVER_URL  base URL of the llull server  (default: http://localhost:3001)
 */

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://localhost:3001';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL  ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${msg}`);
  }
}

async function run(): Promise<void> {
  console.log(`\nverify-export-download  →  ${SERVER_URL}\n`);

  // ------------------------------------------------------------------
  // 1. Seed the live document with a box via POST /command.
  // ------------------------------------------------------------------
  console.log('1. Seed: POST /command add_box');
  const cmdRes = await fetch(`${SERVER_URL}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'add_box', params: { size: [2, 2, 2], position: [0, 0, 0] } }),
  });
  assert(cmdRes.ok, `POST /command status ${cmdRes.status} is 2xx`);
  const cmdBody = (await cmdRes.json()) as { affected: string[]; isError: boolean };
  assert(!cmdBody.isError, 'add_box is not an error');
  assert(cmdBody.affected.length === 1, 'add_box created one entity');

  // ------------------------------------------------------------------
  // 2. ASCII download.
  // ------------------------------------------------------------------
  console.log('\n2. GET /export/stl  (ascii)');
  const asciiRes = await fetch(`${SERVER_URL}/export/stl`);
  assert(asciiRes.ok, `status ${asciiRes.status} is 2xx`);
  assert(
    (asciiRes.headers.get('content-type') ?? '').includes('model/stl'),
    'Content-Type: model/stl',
  );
  assert(
    (asciiRes.headers.get('content-disposition') ?? '').includes('attachment'),
    'Content-Disposition: attachment',
  );
  assert(
    (asciiRes.headers.get('content-disposition') ?? '').includes('llull.stl'),
    'Content-Disposition filename: llull.stl',
  );
  const asciiBody = await asciiRes.text();
  assert(asciiBody.startsWith('solid '), "body starts with 'solid '");
  assert(asciiBody.includes('facet normal'), 'body contains triangle data');

  // ------------------------------------------------------------------
  // 3. Binary download.
  // ------------------------------------------------------------------
  console.log('\n3. GET /export/stl?format=binary');
  const binRes = await fetch(`${SERVER_URL}/export/stl?format=binary`);
  assert(binRes.ok, `status ${binRes.status} is 2xx`);
  const binBuf = Buffer.from(await binRes.arrayBuffer());
  const triangleCount = binBuf.readUInt32LE(80);
  const expectedLength = 84 + triangleCount * 50;
  assert(triangleCount > 0, `triangleCount=${triangleCount} > 0`);
  assert(binBuf.length === expectedLength, `buffer length = 84 + ${triangleCount}*50 = ${expectedLength}`);

  // ------------------------------------------------------------------
  // 4. Custom name param.
  // ------------------------------------------------------------------
  console.log('\n4. GET /export/stl?name=mypart');
  const nameRes = await fetch(`${SERVER_URL}/export/stl?name=mypart`);
  assert(nameRes.ok, `status ${nameRes.status} is 2xx`);
  assert(
    (nameRes.headers.get('content-disposition') ?? '').includes('mypart.stl'),
    'Content-Disposition filename: mypart.stl',
  );
  const nameBody = await nameRes.text();
  assert(nameBody.includes('solid mypart'), "body contains 'solid mypart'");

  console.log('\nDone.\n');
}

run().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
