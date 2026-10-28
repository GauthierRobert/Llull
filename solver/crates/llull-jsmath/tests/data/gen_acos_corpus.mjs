// Regenerates acos_corpus.txt: `x acos(x)` as f64 bit patterns from node (V8 Math.acos), a seeded stream over [-1, 1] with the edges that
// pick each branch of the function. Usage: node gen_acos_corpus.mjs > acos_corpus.txt
const view = new DataView(new ArrayBuffer(8));
const bits = (value) => {
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
let state = 123456789n;
const next = () => {
  state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return Number(state >> 11n) / 2 ** 53;
};
const xs = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  0.4999999999999999,
  -0.4999999999999999,
  1e-20,
  -1e-20,
  2 ** -58,
  2 ** -57,
  1 - 2 ** -53,
  -1 + 2 ** -53,
  1.5,
  -1.5,
  NaN,
];
for (let i = 0; i < 4000; i++) xs.push(next() * 2 - 1);
for (let i = 0; i < 1000; i++) xs.push((next() * 2 - 1) * 1e-3);
for (let i = 0; i < 1000; i++) xs.push(Math.sign(next() - 0.5) * (1 - next() * 1e-6));
const lines = ['# x acos(x) as f64 bit patterns from node (V8 Math.acos); regenerate with gen_acos_corpus.mjs'];
for (const x of xs) lines.push(`${bits(x)} ${bits(Math.acos(x))}`);
process.stdout.write(`${lines.join('\n')}\n`);
