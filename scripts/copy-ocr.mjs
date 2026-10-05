// Copies Tesseract's worker, WASM core and language data into web/public/ocr
// so the app serves them itself (src/lib/ocr.ts explains why). Runs before
// `dev` and `build`; the output is gitignored because it is reproducible
// from node_modules.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = (name) => path.dirname(require.resolve(`${name}/package.json`));
const out = path.join(import.meta.dirname, '..', 'web', 'public', 'ocr');

const copy = (from, to) => {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
};

copy(path.join(pkg('tesseract.js'), 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));

// LSTM-only builds: the app always runs OEM 1, so the legacy engine is dead weight.
for (const build of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  const file = `tesseract-core-${build}.wasm.js`;
  copy(path.join(pkg('tesseract.js-core'), file), path.join(out, 'core', file));
}

for (const lang of ['eng', 'ind']) {
  const file = `${lang}.traineddata.gz`;
  copy(path.join(pkg(`@tesseract.js-data/${lang}`), '4.0.0_best_int', file), path.join(out, 'lang', file));
}
