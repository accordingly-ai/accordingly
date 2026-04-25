/**
 * Extract AcroForm field manifests from every PDF in `public/forms/pdfs/`
 * into `src/forms/<id>.json`. Re-run with `pnpm forms:extract`.
 *
 * Each field gets a kebab-case `name` slug (canonical id) and a separate
 * `pdfName` that preserves the raw AcroForm field name for PDF round-trip.
 *
 * Two label-extraction paths, picked by detecting whether the source PDF
 * has tooltip metadata:
 *   Path A — TU tooltips present (e.g. ACORD 126): slug from raw name,
 *            label from TU.
 *   Path B — no TU tooltips (e.g. ACORD 125): label is the nearest printed
 *            text run to each widget rect (spatial heuristic), slug derived
 *            from the chosen label.
 *
 * Per-form overrides at `scripts/overrides/<formId>.json` replace heuristic
 * output for specific raw PDF names.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFSignature,
  PDFName,
  PDFString,
  PDFHexString,
} from 'pdf-lib';

const ROOT = resolve(import.meta.dirname, '..');
const PDF_DIR = join(ROOT, 'public/forms/pdfs');
const OUT_DIR = join(ROOT, 'src/forms');
const OVERRIDES_DIR = join(ROOT, 'scripts/overrides');

type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature';

interface FieldEntry {
  name: string;
  pdfName: string;
  type: FieldType;
  label: string;
  page: number;
  rect: [number, number, number, number];
  options?: string[];
  option?: string;
  maxLength?: number;
}

interface Manifest {
  id: string;
  title: string;
  fields: FieldEntry[];
}

interface OverrideEntry {
  name?: string;
  label?: string;
}
type Overrides = Record<string, OverrideEntry>;

const FORM_TITLES: Record<string, string> = {
  'acord-125': 'ACORD 125 — Commercial Insurance Application',
  'acord-126': 'ACORD 126 — Commercial General Liability Section',
};

export function classify(field: unknown): FieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'dropdown';
  if (field instanceof PDFSignature) return 'signature';
  return 'text';
}

function readTU(field: { acroField: { dict: { lookup: (n: PDFName) => unknown } } }): string | null {
  const v = field.acroField.dict.lookup(PDFName.of('TU'));
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return null;
}

// --- Slug helpers --------------------------------------------------------

function collapseDashes(s: string): string {
  return s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugifyText(s: string): string {
  return collapseDashes(s.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

/** Path A: slug from raw AcroForm name like `Producer_FullName_A`. */
export function slugFromRawName(name: string): string {
  // Insert breaks at CamelCase boundaries before lowercasing.
  let s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  s = s.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-');
  // Strip ACORD copy/edition suffix: trailing `-<single-letter>`.
  s = s.replace(/-[a-z]$/, '');
  return collapseDashes(s);
}

// --- Path A label cleanup ------------------------------------------------

const TU_LEAD_RE =
  /^(?:enter\s+(?:text|date|identifier|code|number|amount|name|description)|select(?:\s+an?)?(?:\s+option)?|check\s+the\s+box(?:\s*\(if\s+applicable\))?|sign\s+here)\s*[:\-]?\s*/i;

function cleanTU(tu: string): string {
  let s = tu.replace(/\s+/g, ' ').trim();
  s = s.replace(TU_LEAD_RE, '');
  // First sentence (up to first `.`), but only if followed by space/end.
  const m = s.match(/^([^.]+?\.)(?:\s|$)/);
  if (m) s = m[1];
  s = s.trim();
  if (s.length > 120) s = s.slice(0, 117).trimEnd() + '…';
  return s;
}

// --- Path B: spatial label heuristic via pdfjs-dist ----------------------

interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const CHROME_RE = /^(?:ACORD|Page|of|FAX|©|Copyright|All\s+Rights\s+Reserved|TM|®)$/i;

function isUsefulText(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  // Single punctuation/digit/letter — skip.
  if (t.length === 1) return false;
  if (CHROME_RE.test(t)) return false;
  // Skip pure punctuation / numeric-only short tokens.
  if (/^[\s\W_]+$/.test(t)) return false;
  return true;
}

async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  // Use the legacy build, which works in Node without DOM globals. Point
  // `workerSrc` at the worker on disk so pdfjs spawns a real worker.
  const require = createRequire(import.meta.url);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    // pdfjs falls back to a fake in-process worker if workerSrc is unset.
  }
  return pdfjs;
}

async function extractPageText(
  pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs'),
  bytes: Uint8Array,
  numPages: number,
): Promise<TextItem[][]> {
  // pdfjs mutates the buffer it's given; pass a copy.
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const out: TextItem[][] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of tc.items) {
      const item = it as { str?: string; transform?: number[]; width?: number; height?: number };
      if (typeof item.str !== 'string' || !item.transform) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const width = typeof item.width === 'number' ? item.width : 0;
      const height = typeof item.height === 'number' ? item.height : 10;
      items.push({ str: item.str, x, y, width, height });
    }
    out.push(items);
  }
  await doc.destroy();
  return out;
}

interface Widget {
  rect: [number, number, number, number];
  page: number;
}

function bestLabelFor(widget: Widget, items: TextItem[]): string | null {
  const [wx, wy, ww, wh] = widget.rect;
  const wTop = wy + wh;
  const wRight = wx + ww;
  const wCenterY = wy + wh / 2;

  let best: { score: number; str: string } | null = null;

  for (const item of items) {
    if (!isUsefulText(item.str)) continue;
    const tLeft = item.x;
    const tRight = item.x + item.width;
    const tBaseline = item.y;
    const tTop = item.y + item.height;
    const tCenterY = item.y + item.height / 2;

    // Mode 1: text directly above the widget, in the same column-ish.
    // The text's baseline (or top) should sit a short distance above the
    // widget's top edge.
    const aboveGap = tBaseline - wTop;
    if (aboveGap >= -2 && aboveGap <= 30) {
      // Horizontal overlap or near-overlap with the widget column.
      const horizGap = Math.max(0, wx - tRight, tLeft - wRight);
      if (horizGap <= 60) {
        const score = aboveGap * 2 + horizGap * 0.7;
        if (!best || score < best.score) best = { score, str: item.str };
      }
    }

    // Mode 2: text immediately to the left on the same baseline.
    const leftGap = wx - tRight;
    if (leftGap >= -2 && leftGap <= 80) {
      const verticalMiss = Math.abs(tCenterY - wCenterY);
      // Allow text that overlaps the widget vertically (big margin) or sits
      // on the same baseline within the widget height.
      if (verticalMiss <= Math.max(8, wh)) {
        // A small penalty over "above" mode so above wins ties.
        const score = leftGap * 1 + verticalMiss * 1.2 + 4;
        if (!best || score < best.score) best = { score, str: item.str };
      }
    }

    // Mode 3: text starting inside the widget's bounding box but above the
    // bottom — useful for cases where pdf-lib's rect overshoots downward.
    if (tTop <= wTop + 4 && tBaseline >= wy - 4 && tLeft >= wx - 4 && tLeft <= wRight + 4) {
      const score = 12; // last resort
      if (!best || score < best.score) best = { score, str: item.str };
    }
  }

  return best ? best.str.trim() : null;
}

// --- Override loading ----------------------------------------------------

function loadOverrides(formId: string): Overrides {
  const path = join(OVERRIDES_DIR, `${formId}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Overrides;
  } catch (e) {
    throw new Error(`Failed to parse overrides at ${path}: ${(e as Error).message}`);
  }
}

// --- Slug uniqueness -----------------------------------------------------

function uniquifySlugs(input: Map<string, { slug: string; label: string }>): Map<
  string,
  { slug: string; label: string }
> {
  // Group rawNames by proposed slug.
  const bySlug = new Map<string, string[]>();
  for (const [raw, { slug }] of input) {
    const arr = bySlug.get(slug) ?? [];
    arr.push(raw);
    bySlug.set(slug, arr);
  }
  const out = new Map<string, { slug: string; label: string }>();
  for (const [slug, raws] of bySlug) {
    raws.sort();
    raws.forEach((raw, i) => {
      const final = i === 0 ? slug : `${slug}-${i + 1}`;
      const orig = input.get(raw)!;
      out.set(raw, { slug: final, label: orig.label });
    });
  }
  return out;
}

// --- Main extraction -----------------------------------------------------

async function extract(pdfPath: string): Promise<Manifest> {
  const id = basename(pdfPath, '.pdf');
  const bytes = readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.getForm();
  const fields = form.getFields();
  const pages = doc.getPages();
  const pageRefs = pages.map((p) => p.ref);

  if (fields.length === 0) {
    throw new Error(
      `${id}.pdf has no AcroForm fields — verify the source PDF is a fillable form, not a flattened scan.`,
    );
  }

  // Pre-compute widget→page mappings, rects, raw names, types per field.
  interface RawField {
    rawName: string;
    type: FieldType;
    options?: string[];
    maxLength?: number;
    tu: string | null;
    widgets: { rect: [number, number, number, number]; page: number; option?: string }[];
  }

  const rawFields: RawField[] = [];
  let anyTU = false;

  for (const field of fields) {
    const rawName = field.getName();
    const type = classify(field);
    const tu = readTU(field as unknown as { acroField: { dict: { lookup: (n: PDFName) => unknown } } });
    if (tu) anyTU = true;

    let options: string[] | undefined;
    let maxLength: number | undefined;
    if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      options = field.getOptions();
    }
    if (field instanceof PDFTextField) {
      const m = field.getMaxLength();
      if (typeof m === 'number') maxLength = m;
    }

    const isRadio = field instanceof PDFRadioGroup;
    const widgets = field.acroField.getWidgets();
    const widgetEntries: RawField['widgets'] = [];
    for (let widgetIdx = 0; widgetIdx < widgets.length; widgetIdx++) {
      const widget = widgets[widgetIdx];
      const rect = widget.getRectangle();
      const pRef = widget.P();
      let page = pRef ? pageRefs.findIndex((r) => r === pRef) : -1;
      if (page === -1) {
        const widgetRef = (widget as unknown as { ref?: unknown }).ref;
        for (let i = 0; i < pages.length; i++) {
          const annots = pages[i].node.Annots();
          if (!annots) continue;
          const arr = annots.asArray();
          if (arr.some((a) => a === widgetRef)) {
            page = i;
            break;
          }
        }
      }
      const widgetOption = isRadio && options ? options[widgetIdx] : undefined;
      widgetEntries.push({
        rect: [rect.x, rect.y, rect.width, rect.height],
        page,
        ...(widgetOption !== undefined ? { option: widgetOption } : {}),
      });
    }

    rawFields.push({ rawName, type, options, maxLength, tu, widgets: widgetEntries });
  }

  // Build rawName → { slug, label } map. Path A vs Path B by tooltip presence.
  const proposed = new Map<string, { slug: string; label: string }>();

  if (anyTU) {
    // Path A.
    for (const rf of rawFields) {
      if (proposed.has(rf.rawName)) continue;
      const slug = slugFromRawName(rf.rawName) || slugifyText(rf.rawName);
      const label = rf.tu ? cleanTU(rf.tu) : '';
      proposed.set(rf.rawName, { slug, label });
    }
  } else {
    // Path B — spatial label extraction.
    const pdfjs = await loadPdfjs();
    const pageText = await extractPageText(pdfjs, bytes, pages.length);

    // Collect candidate labels per rawName by inspecting each widget.
    const labelsByRaw = new Map<string, string[]>();
    for (const rf of rawFields) {
      for (const w of rf.widgets) {
        if (w.page < 0 || w.page >= pageText.length) continue;
        if (w.rect[2] <= 0 || w.rect[3] <= 0) continue;
        const label = bestLabelFor(w, pageText[w.page]);
        if (label) {
          const arr = labelsByRaw.get(rf.rawName) ?? [];
          arr.push(label);
          labelsByRaw.set(rf.rawName, arr);
        }
      }
    }

    for (const rf of rawFields) {
      if (proposed.has(rf.rawName)) continue;
      const candidates = labelsByRaw.get(rf.rawName) ?? [];
      // Majority vote.
      let label = '';
      if (candidates.length > 0) {
        const counts = new Map<string, number>();
        for (const c of candidates) counts.set(c, (counts.get(c) ?? 0) + 1);
        label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      const slugBase = label ? slugifyText(label) : '';
      const slug = slugBase || slugifyText(rf.rawName);
      proposed.set(rf.rawName, { slug, label });
    }
  }

  // Apply uniqueness across all rawNames.
  const resolved = uniquifySlugs(proposed);

  // Apply overrides last.
  const overrides = loadOverrides(id);
  for (const [raw, ov] of Object.entries(overrides)) {
    const cur = resolved.get(raw);
    if (!cur) continue;
    resolved.set(raw, {
      slug: ov.name ?? cur.slug,
      label: ov.label ?? cur.label,
    });
  }

  // Emit one entry per widget.
  const entries: FieldEntry[] = [];
  for (const rf of rawFields) {
    const r = resolved.get(rf.rawName);
    if (!r) continue;
    for (const w of rf.widgets) {
      entries.push({
        name: r.slug,
        pdfName: rf.rawName,
        type: rf.type,
        label: r.label,
        page: w.page,
        rect: w.rect,
        ...(rf.options ? { options: rf.options } : {}),
        ...(w.option !== undefined ? { option: w.option } : {}),
        ...(rf.maxLength !== undefined ? { maxLength: rf.maxLength } : {}),
      });
    }
  }

  return {
    id,
    title: FORM_TITLES[id] ?? id,
    fields: entries,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const pdfs = readdirSync(PDF_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (pdfs.length === 0) {
    throw new Error(`No PDFs found in ${PDF_DIR}`);
  }

  for (const pdf of pdfs) {
    const manifest = await extract(join(PDF_DIR, pdf));
    const out = join(OUT_DIR, `${manifest.id}.json`);
    writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`✓ ${manifest.id}: ${manifest.fields.length} field widgets → ${out}`);
  }
}

// Only run when invoked directly (not when imported by tests).
const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
