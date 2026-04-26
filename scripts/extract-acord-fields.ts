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
 *            label from TU. One logical group per AcroForm field.
 *   Path B — no TU tooltips (e.g. ACORD 125): label is the nearest printed
 *            text run to each widget rect (spatial heuristic), slug derived
 *            from the chosen label. Adjacent Y/N checkbox pairs collapse
 *            into a single radio field with `yes`/`no` options.
 *
 * Per-form overrides at `scripts/overrides/<formId>.json` rename or relabel
 * specific widgets. See `OverrideFile` for the supported shapes.
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

/**
 * Find the printed text most likely to be the visible label for `widget`.
 *
 * The narrow window (above-15pt / left-80pt / inside) wins when it returns a
 * hit; only when nothing matches do we fall back to wider modes (above-60pt,
 * left-140pt, below-18pt). Existing good labels never regress.
 */
export function bestLabelFor(widget: Widget, items: TextItem[]): string | null {
  const narrow = findLabel(widget, items, /* widen */ false);
  if (narrow !== null) return narrow;
  return findLabel(widget, items, /* widen */ true);
}

function findLabel(widget: Widget, items: TextItem[], widen: boolean): string | null {
  const [wx, wy, ww, wh] = widget.rect;
  const wTop = wy + wh;
  const wRight = wx + ww;
  const wCenterY = wy + wh / 2;

  const aboveMax = widen ? 60 : 30;
  const leftMax = widen ? 140 : 80;

  let best: { score: number; str: string } | null = null;
  // Track short text runs in reading order for the "two-short-runs" fallback.
  const shortRuns: { x: number; y: number; str: string; dist: number }[] = [];

  for (const item of items) {
    if (!isUsefulText(item.str)) continue;
    const tLeft = item.x;
    const tRight = item.x + item.width;
    const tBaseline = item.y;
    const tTop = item.y + item.height;
    const tCenterY = item.y + item.height / 2;

    // Mode 1: text directly above the widget, in the same column-ish.
    const aboveGap = tBaseline - wTop;
    if (aboveGap >= -2 && aboveGap <= aboveMax) {
      const horizGap = Math.max(0, wx - tRight, tLeft - wRight);
      if (horizGap <= 60) {
        const score = aboveGap * 2 + horizGap * 0.7;
        if (!best || score < best.score) best = { score, str: item.str };
      }
    }

    // Mode 2: text immediately to the left on the same baseline.
    const leftGap = wx - tRight;
    if (leftGap >= -2 && leftGap <= leftMax) {
      const verticalMiss = Math.abs(tCenterY - wCenterY);
      if (verticalMiss <= Math.max(8, wh)) {
        // A small penalty over "above" mode so above wins ties.
        const score = leftGap * 1 + verticalMiss * 1.2 + 4;
        if (!best || score < best.score) best = { score, str: item.str };
        if (widen && item.str.trim().length < 4) {
          shortRuns.push({ x: tLeft, y: tBaseline, str: item.str, dist: leftGap + verticalMiss });
        }
      }
    }

    // Mode 3: text starting inside the widget's bounding box but above the
    // bottom — useful for cases where pdf-lib's rect overshoots downward.
    if (tTop <= wTop + 4 && tBaseline >= wy - 4 && tLeft >= wx - 4 && tLeft <= wRight + 4) {
      const score = 12; // last resort
      if (!best || score < best.score) best = { score, str: item.str };
    }

    // Mode 4 (widen-only): text directly below the widget. Useful for sub-row
    // labels printed under the input.
    if (widen) {
      const belowGap = wy - tTop;
      if (belowGap >= -2 && belowGap <= 18) {
        const horizGap = Math.max(0, wx - tRight, tLeft - wRight);
        if (horizGap <= 60) {
          const score = belowGap * 2 + horizGap * 0.7 + 6;
          if (!best || score < best.score) best = { score, str: item.str };
        }
      }
    }
  }

  if (best) return best.str.trim();

  // Fallback: if no single run won and we're widening, stitch the closest two
  // short runs together in reading order.
  if (widen && shortRuns.length >= 2) {
    shortRuns.sort((a, b) => a.dist - b.dist);
    const top = shortRuns.slice(0, 2).sort((a, b) => a.x - b.x);
    return top.map((r) => r.str.trim()).join(' ').trim() || null;
  }

  return null;
}

// --- Override schema -----------------------------------------------------

interface OverrideEntry {
  name?: string;
  label?: string;
}

interface OverrideFile {
  [rawName: string]:
    | OverrideEntry
    | { widgets: OverrideEntry[] }
    | { byPage: Record<string, OverrideEntry> };
}

interface RawField {
  rawName: string;
  type: FieldType;
  options?: string[];
  maxLength?: number;
  tu: string | null;
  widgets: { rect: [number, number, number, number]; page: number; option?: string }[];
}

interface NormalizedOverrides {
  // keyed by `${rawName}#${widgetIdx}`
  byKey: Map<string, OverrideEntry>;
  // raw set of rawNames whose override declares per-widget shape (so we know
  // to split the rawField into multiple groups during application).
  splitRawNames: Set<string>;
}

export function loadOverrides(formId: string): OverrideFile {
  const path = join(OVERRIDES_DIR, `${formId}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OverrideFile;
  } catch (e) {
    throw new Error(`Failed to parse overrides at ${path}: ${(e as Error).message}`);
  }
}

export function normalizeOverrides(file: OverrideFile, rawFields: RawField[]): NormalizedOverrides {
  const byRawName = new Map<string, RawField>();
  for (const rf of rawFields) byRawName.set(rf.rawName, rf);

  const byKey = new Map<string, OverrideEntry>();
  const splitRawNames = new Set<string>();

  for (const [rawName, raw] of Object.entries(file)) {
    if (!raw || typeof raw !== 'object') continue;
    const rf = byRawName.get(rawName);
    const hasWidgets = 'widgets' in raw && Array.isArray((raw as { widgets?: unknown }).widgets);
    const hasByPage = 'byPage' in raw && typeof (raw as { byPage?: unknown }).byPage === 'object';
    const hasLegacyKeys = 'name' in raw || 'label' in raw;
    const hasLegacy = !hasWidgets && !hasByPage && hasLegacyKeys;

    if (hasWidgets && hasByPage) {
      throw new Error(`Override for ${rawName}: cannot mix widgets[] and byPage`);
    }
    if (hasLegacyKeys && (hasWidgets || hasByPage)) {
      throw new Error(`Override for ${rawName}: cannot mix legacy name/label with widgets/byPage`);
    }

    if (hasWidgets) {
      const arr = (raw as { widgets: OverrideEntry[] }).widgets;
      if (!rf) continue;
      if (arr.length !== rf.widgets.length) {
        throw new Error(
          `Override for ${rawName}: widgets[] length ${arr.length} ≠ actual widget count ${rf.widgets.length}`,
        );
      }
      arr.forEach((entry, i) => {
        if (entry) byKey.set(`${rawName}#${i}`, entry);
      });
      splitRawNames.add(rawName);
      continue;
    }

    if (hasByPage) {
      const map = (raw as { byPage: Record<string, OverrideEntry> }).byPage;
      if (!rf) continue;
      for (const [pageStr, entry] of Object.entries(map)) {
        const page = Number(pageStr);
        const widgetIdx = rf.widgets.findIndex((w) => w.page === page);
        if (widgetIdx === -1) {
          throw new Error(`Override for ${rawName}: byPage["${pageStr}"] has no matching widget`);
        }
        if (entry) byKey.set(`${rawName}#${widgetIdx}`, entry);
      }
      splitRawNames.add(rawName);
      continue;
    }

    if (hasLegacy) {
      const entry = raw as OverrideEntry;
      if (!rf) {
        // Still allow legacy overrides for unknown rawNames (no-op below).
        continue;
      }
      for (let i = 0; i < rf.widgets.length; i++) {
        byKey.set(`${rawName}#${i}`, entry);
      }
      // legacy doesn't split — same slug for all widgets.
    }
  }

  return { byKey, splitRawNames };
}

// --- Y/N pair detection --------------------------------------------------

interface PairCandidate {
  rawName: string;
  widgetIdx: number;
  page: number;
  rect: [number, number, number, number];
  label: string;
}

interface DetectedPair {
  yes: PairCandidate;
  no: PairCandidate;
  slug: string;
  label: string;
}

/**
 * Detect Y/N checkbox pairs from a flat list of candidates (Path B only).
 *
 * Algorithm:
 *  - Group by page; within each page sort by (y desc, x asc).
 *  - Walk row-bands (|cyA−cyB| ≤ 3). Within a row, scan left-to-right.
 *  - Two adjacent widgets form a pair when their horizontal edge gap ≤ 22 pt
 *    (allowing tiny overlaps) AND they share a non-empty heuristic label.
 *  - Leftmost = yes, rightmost = no. The shared label seeds the slug.
 */
export function pairYesNo(candidates: PairCandidate[]): DetectedPair[] {
  const byPage = new Map<number, PairCandidate[]>();
  for (const c of candidates) {
    const arr = byPage.get(c.page) ?? [];
    arr.push(c);
    byPage.set(c.page, arr);
  }

  const pairs: DetectedPair[] = [];
  for (const list of byPage.values()) {
    // Sort by y desc (PDF coords), then x asc.
    list.sort((a, b) => {
      const ay = a.rect[1] + a.rect[3] / 2;
      const by = b.rect[1] + b.rect[3] / 2;
      if (Math.abs(ay - by) > 3) return by - ay;
      return a.rect[0] - b.rect[0];
    });

    let i = 0;
    while (i < list.length) {
      const row: PairCandidate[] = [list[i]];
      const cyAnchor = list[i].rect[1] + list[i].rect[3] / 2;
      let j = i + 1;
      while (j < list.length) {
        const cy = list[j].rect[1] + list[j].rect[3] / 2;
        if (Math.abs(cy - cyAnchor) <= 3) {
          row.push(list[j]);
          j++;
        } else break;
      }
      // Within row, walk left-to-right looking for adjacent pairs.
      row.sort((a, b) => a.rect[0] - b.rect[0]);
      let k = 0;
      while (k < row.length - 1) {
        const left = row[k];
        const right = row[k + 1];
        const leftRight = left.rect[0] + left.rect[2];
        const gap = right.rect[0] - leftRight;
        const sameLabel =
          left.label.length > 0 && left.label === right.label;
        if (gap >= -2 && gap <= 22 && sameLabel) {
          pairs.push({
            yes: left,
            no: right,
            slug: slugifyText(left.label),
            label: left.label,
          });
          k += 2;
        } else {
          k += 1;
        }
      }
      i = j;
    }
  }
  return pairs;
}

// --- Logical groups & slug uniqueness ------------------------------------

interface WidgetRef {
  rawName: string;
  widgetIdx: number;
  page: number;
  rect: [number, number, number, number];
  option?: string;
}

interface LogicalGroup {
  slug: string;
  label: string;
  type: FieldType;
  options?: string[];
  maxLength?: number;
  widgets: WidgetRef[];
}

function uniquifyGroups(groups: LogicalGroup[]): void {
  const bySlug = new Map<string, LogicalGroup[]>();
  for (const g of groups) {
    const arr = bySlug.get(g.slug) ?? [];
    arr.push(g);
    bySlug.set(g.slug, arr);
  }
  for (const [, arr] of bySlug) {
    if (arr.length <= 1) continue;
    // Stable order: by first widget's rawName then widgetIdx.
    arr.sort((a, b) => {
      const aw = a.widgets[0];
      const bw = b.widgets[0];
      if (aw.rawName !== bw.rawName) return aw.rawName.localeCompare(bw.rawName);
      return aw.widgetIdx - bw.widgetIdx;
    });
    arr.forEach((g, i) => {
      if (i > 0) g.slug = `${g.slug}-${i + 1}`;
    });
  }
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

  // ---- Build initial logical groups ------------------------------------
  const groups: LogicalGroup[] = [];

  if (anyTU) {
    // Path A: one group per rawField, slug from raw name, label from TU.
    for (const rf of rawFields) {
      const slug = slugFromRawName(rf.rawName) || slugifyText(rf.rawName);
      const label = rf.tu ? cleanTU(rf.tu) : '';
      groups.push({
        slug,
        label,
        type: rf.type,
        options: rf.options,
        maxLength: rf.maxLength,
        widgets: rf.widgets.map((w, i) => ({
          rawName: rf.rawName,
          widgetIdx: i,
          page: w.page,
          rect: w.rect,
          ...(w.option !== undefined ? { option: w.option } : {}),
        })),
      });
    }
  } else {
    // Path B: per-widget label, then collapse Y/N pairs into synthetic radios.
    const pdfjs = await loadPdfjs();
    const pageText = await extractPageText(pdfjs, bytes, pages.length);

    // Per-widget heuristic label.
    const widgetLabels = new Map<string, string>(); // `${rawName}#${i}` → label
    for (const rf of rawFields) {
      for (let i = 0; i < rf.widgets.length; i++) {
        const w = rf.widgets[i];
        if (w.page < 0 || w.page >= pageText.length) continue;
        if (w.rect[2] <= 0 || w.rect[3] <= 0) continue;
        const label = bestLabelFor(w, pageText[w.page]);
        if (label) widgetLabels.set(`${rf.rawName}#${i}`, label);
      }
    }

    // Detect Y/N pairs across all checkbox widgets.
    const pairCandidates: PairCandidate[] = [];
    const widgetIsCheckbox = new Map<string, boolean>();
    for (const rf of rawFields) {
      if (rf.type !== 'checkbox') continue;
      for (let i = 0; i < rf.widgets.length; i++) {
        const key = `${rf.rawName}#${i}`;
        widgetIsCheckbox.set(key, true);
        pairCandidates.push({
          rawName: rf.rawName,
          widgetIdx: i,
          page: rf.widgets[i].page,
          rect: rf.widgets[i].rect,
          label: widgetLabels.get(key) ?? '',
        });
      }
    }
    const pairs = pairYesNo(pairCandidates);
    const pairedWidgetKeys = new Set<string>();
    for (const p of pairs) {
      pairedWidgetKeys.add(`${p.yes.rawName}#${p.yes.widgetIdx}`);
      pairedWidgetKeys.add(`${p.no.rawName}#${p.no.widgetIdx}`);
    }

    // Emit synthetic radio groups for each detected pair.
    for (const p of pairs) {
      groups.push({
        slug: p.slug,
        label: p.label,
        type: 'radio',
        options: ['yes', 'no'],
        widgets: [
          {
            rawName: p.yes.rawName,
            widgetIdx: p.yes.widgetIdx,
            page: p.yes.page,
            rect: p.yes.rect,
            option: 'yes',
          },
          {
            rawName: p.no.rawName,
            widgetIdx: p.no.widgetIdx,
            page: p.no.page,
            rect: p.no.rect,
            option: 'no',
          },
        ],
      });
    }

    // For non-paired widgets, emit one group per rawField, but group widgets
    // by majority-voted label (matches today's Path B behaviour).
    for (const rf of rawFields) {
      const remainingWidgets = rf.widgets
        .map((w, i) => ({ w, i }))
        .filter(({ i }) => !pairedWidgetKeys.has(`${rf.rawName}#${i}`));
      if (remainingWidgets.length === 0) continue;
      const counts = new Map<string, number>();
      for (const { i } of remainingWidgets) {
        const lab = widgetLabels.get(`${rf.rawName}#${i}`) ?? '';
        if (lab) counts.set(lab, (counts.get(lab) ?? 0) + 1);
      }
      let label = '';
      if (counts.size > 0) {
        label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      const slugBase = label ? slugifyText(label) : '';
      const slug = slugBase || slugifyText(rf.rawName);
      groups.push({
        slug,
        label,
        type: rf.type,
        options: rf.options,
        maxLength: rf.maxLength,
        widgets: remainingWidgets.map(({ w, i }) => ({
          rawName: rf.rawName,
          widgetIdx: i,
          page: w.page,
          rect: w.rect,
          ...(w.option !== undefined ? { option: w.option } : {}),
        })),
      });
    }
  }

  // ---- Apply overrides --------------------------------------------------
  const overrideFile = loadOverrides(id);
  const overrides = normalizeOverrides(overrideFile, rawFields);

  const finalGroups: LogicalGroup[] = [];
  for (const g of groups) {
    // Identify override mode for this group's rawName(s).
    // A synthetic radio group spans two rawNames; we apply per-widget overrides
    // for either rawName independently if present.
    const hasSplitMember = g.widgets.some((w) => overrides.splitRawNames.has(w.rawName));

    if (!hasSplitMember) {
      // Legacy override: applies uniformly. Pick from any widget's key.
      const w0 = g.widgets[0];
      const ov = overrides.byKey.get(`${w0.rawName}#${w0.widgetIdx}`);
      if (ov) {
        g.slug = ov.name ?? g.slug;
        g.label = ov.label ?? g.label;
      }
      finalGroups.push(g);
      continue;
    }

    // Split group: one new logical group per (slug, label) combination.
    const subgroups = new Map<string, LogicalGroup>();
    for (const w of g.widgets) {
      const ov = overrides.byKey.get(`${w.rawName}#${w.widgetIdx}`);
      const slug = ov?.name ?? g.slug;
      const label = ov?.label ?? g.label;
      const key = `${slug}\x00${label}`;
      let sub = subgroups.get(key);
      if (!sub) {
        sub = {
          slug,
          label,
          type: g.type,
          options: g.options,
          maxLength: g.maxLength,
          widgets: [],
        };
        subgroups.set(key, sub);
      }
      sub.widgets.push(w);
    }
    for (const sub of subgroups.values()) finalGroups.push(sub);
  }

  // ---- Uniquify slugs ---------------------------------------------------
  uniquifyGroups(finalGroups);

  // ---- Diagnostics: warn on residual generic slugs / empty labels -------
  const GENERIC_SLUG_RE = /^(check-box|text|\d+(text|loc|bld|ann|%))/i;
  for (const g of finalGroups) {
    if (!g.label) {
      console.warn(`[${id}] empty label for slug "${g.slug}" (widgets: ${g.widgets.map((w) => `${w.rawName}#${w.widgetIdx}`).join(', ')})`);
    }
    if (GENERIC_SLUG_RE.test(g.slug)) {
      console.warn(`[${id}] generic slug "${g.slug}" (widgets: ${g.widgets.map((w) => `${w.rawName}#${w.widgetIdx}`).join(', ')})`);
    }
  }

  // ---- Emit one entry per widget ----------------------------------------
  const entries: FieldEntry[] = [];
  for (const g of finalGroups) {
    for (const w of g.widgets) {
      entries.push({
        name: g.slug,
        pdfName: w.rawName,
        type: g.type,
        label: g.label,
        page: w.page,
        rect: w.rect,
        ...(g.options ? { options: g.options } : {}),
        ...(w.option !== undefined ? { option: w.option } : {}),
        ...(g.maxLength !== undefined ? { maxLength: g.maxLength } : {}),
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
