// Read a PDF's text with positions (pdfjs-dist legacy build, plain Node).
// Returns pages: [{ index, width, height, items: [{ str, x, y, w, h }] }]
// x / y are PDF points from the bottom-left corner (y = text baseline).
let libPromise = null;

function loadPdfjs() {
  if (!libPromise) {
    libPromise = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // Run the worker code in this process (no worker file to find on Vercel).
      if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return pdfjs;
    })().catch((err) => {
      libPromise = null;
      throw err;
    });
  }
  return libPromise;
}

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

async function readPdfText(buffer) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw bad('This PDF has a password. Upload the statement without a password.');
    throw bad('Could not read this PDF');
  }
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const [x0, y0, x1, y1] = page.view;
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const str = String(it.str || '').trim();
        if (!str) continue;
        items.push({ str, x: it.transform[4] - x0, y: it.transform[5] - y0, w: it.width, h: it.height || Math.abs(it.transform[3]) || 8 });
      }
      pages.push({ index: i - 1, width: x1 - x0, height: y1 - y0, rotate: page.rotate || 0, items });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

module.exports = { readPdfText };
