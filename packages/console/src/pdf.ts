// A tiny PDF writer for text statements: Letter pages, the built-in Helvetica fonts, no dependencies.

export interface PdfText {
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  /** 'right' puts the end of the text at x. */
  align?: 'left' | 'right';
  /** 0-1 grey level; 0 is black. */
  grey?: number;
}
export interface PdfLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  grey?: number;
}
export interface PdfPage {
  texts: PdfText[];
  lines?: PdfLine[];
}

export const PAGE_W = 612;
export const PAGE_H = 792;

// Helvetica advance widths (per 1000 em) for printable ASCII, from the standard font metrics.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Bold digits, money signs and punctuation match regular closely enough for right-aligned amounts; letters are ~5% wider.
export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of winAnsi(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32]! : 556;
  }
  return ((bold ? w * 1.05 : w) * size) / 1000;
}

/** Keeps to the characters the built-in fonts can show. */
function winAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‒-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA2\xB7]/g, '?');
}

const esc = (s: string) => winAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`);
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export function buildPdf(pages: PdfPage[], title: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // the new length is the object number, which starts at 1
  const catalog = add('');
  const pagesObj = add('');
  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${esc(title)}) /Producer (VGO Rewards) >>`);
  const kids: number[] = [];
  for (const page of pages) {
    const ops: string[] = [];
    for (const l of page.lines ?? []) ops.push(`${num(l.grey ?? 0.8)} G 0.75 w ${num(l.x1)} ${num(l.y1)} m ${num(l.x2)} ${num(l.y2)} l S`);
    for (const t of page.texts) {
      const size = t.size ?? 10;
      const x = t.align === 'right' ? t.x - textWidth(t.text, size, t.bold) : t.x;
      ops.push(`BT /${t.bold ? 'F2' : 'F1'} ${size} Tf ${num(t.grey ?? 0)} g ${num(x)} ${num(t.y)} Td (${esc(t.text)}) Tj ET`);
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
