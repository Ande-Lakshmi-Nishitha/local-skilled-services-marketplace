// Does the embedding model load, and does it understand meaning?
//   npm run check:model
import './_env';
import { embedder } from '../src/lib/embeddings';

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

async function main() {
  const e = embedder();
  console.log(`model: ${e.name}, dimension ${e.dim}`);
  let t = Date.now();
  await e.embed('warm up');
  console.log(`load + first embedding: ${Date.now() - t} ms (the first run also downloads the model)`);

  const pairs: [string, string][] = [
    ['AC not cooling', 'air conditioner gives weak cooling'],
    ['fan not spinning', 'ceiling fan repair and capacitor replacement'],
    ['tap is dripping', 'plumber for leaking taps'],
    ['AC not cooling', 'maths tuition for class 10'],
    ['fan not spinning', 'sofa shampooing'],
  ];
  t = Date.now();
  const vecs = await e.embedBatch(pairs.flat());
  console.log(`10 embeddings in one batch: ${Date.now() - t} ms\n`);
  pairs.forEach(([a, b], i) => console.log(`${cos(vecs[2 * i], vecs[2 * i + 1]).toFixed(3)}  "${a}"  vs  "${b}"`));
  const related = [0, 1, 2].map((i) => cos(vecs[2 * i], vecs[2 * i + 1]));
  const unrelated = [3, 4].map((i) => cos(vecs[2 * i], vecs[2 * i + 1]));
  const ok = Math.min(...related) > Math.max(...unrelated) + 0.1;
  console.log(ok ? '\nOK: related pairs score clearly higher than unrelated ones.' : '\nWARNING: the model does not separate related from unrelated text (hash fallback?).');
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
