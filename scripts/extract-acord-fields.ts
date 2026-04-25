/**
 * Extract AcroForm field manifests from every PDF in `public/forms/pdfs/`
 * into `src/forms/<id>.json`. Re-run with `pnpm forms:extract`.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFSignature,
} from 'pdf-lib';

const ROOT = resolve(import.meta.dirname, '..');
const PDF_DIR = join(ROOT, 'public/forms/pdfs');
const OUT_DIR = join(ROOT, 'src/forms');

type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature';

interface FieldEntry {
  name: string;
  type: FieldType;
  label: string;
  page: number;
  rect: [number, number, number, number];
  options?: string[];
  /** For an individual radio-group widget: the option value this widget represents. */
  option?: string;
  maxLength?: number;
}

interface Manifest {
  id: string;
  title: string;
  fields: FieldEntry[];
}

// TODO: hand-curate human labels — AcroForm names are terse / cryptic.
function deriveLabel(name: string): string {
  const tail = name.split(/[._/\\]/).pop() ?? name;
  return tail
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(field: unknown): FieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'dropdown';
  if (field instanceof PDFSignature) return 'signature';
  return 'text';
}

const FORM_TITLES: Record<string, string> = {
  'acord-125': 'ACORD 125 — Commercial Insurance Application',
  'acord-126': 'ACORD 126 — Commercial General Liability Section',
};

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

  const entries: FieldEntry[] = [];
  for (const field of fields) {
    const name = field.getName();
    const type = classify(field);
    const label = deriveLabel(name);

    let options: string[] | undefined;
    let maxLength: number | undefined;
    if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      options = field.getOptions();
    }
    if (field instanceof PDFTextField) {
      const m = field.getMaxLength();
      if (typeof m === 'number') maxLength = m;
    }

    const widgets = field.acroField.getWidgets();
    const isRadio = field instanceof PDFRadioGroup;
    for (let widgetIdx = 0; widgetIdx < widgets.length; widgetIdx++) {
      const widget = widgets[widgetIdx];
      const rect = widget.getRectangle();
      const pRef = widget.P();
      let page = pRef ? pageRefs.findIndex((r) => r === pRef) : -1;
      if (page === -1) {
        // Fallback: scan pages' Annots for this widget.
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

      entries.push({
        name,
        type,
        label,
        page,
        rect: [rect.x, rect.y, rect.width, rect.height],
        ...(options ? { options } : {}),
        ...(widgetOption !== undefined ? { option: widgetOption } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
