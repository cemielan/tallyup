/**
 * Receipt OCR, entirely in the browser (FR-201). The photo is decoded,
 * downscaled and read on this device; nothing about it is uploaded.
 *
 * Tesseract's worker, WASM core and language data are self-hosted under
 * /ocr (copied there by scripts/copy-ocr.mjs) so the page's CSP can stay
 * 'self' and no third party learns that a receipt was scanned. The first
 * scan downloads about 8 MB; the service worker keeps it afterwards.
 */

/** Long-edge cap. Larger photos cost seconds without improving recognition. */
const MAX_EDGE = 2000;

async function downscale(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  // Grayscale helps faded thermal print more than it hurts anything else.
  ctx.filter = 'grayscale(1) contrast(1.2)';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

export async function readReceipt(file: Blob, onProgress: (fraction: number, label: string) => void): Promise<string> {
  onProgress(0, 'Preparing photo');
  const image = await downscale(file);

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['ind', 'eng'], 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    // A same-origin worker file rather than a blob: URL, so CSP needs no blob: for workers.
    workerBlobURL: false,
    // The service worker already caches the language files; IndexedDB would store them twice.
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) => {
      onProgress(m.status === 'recognizing text' ? m.progress : 0, m.status);
    },
  });

  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
    image.width = 0; // release the pixels now rather than at the next GC
  }
}
