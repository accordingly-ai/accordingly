import { describe, expect, it } from 'vitest';
import { forms } from './index';
import type { FormFieldType, FormManifest } from './types';

const ALLOWED_TYPES: FormFieldType[] = ['text', 'checkbox', 'radio', 'dropdown', 'signature'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GENERIC_SLUG_RE = /^(check-box|text|\d+(text|loc|bld|ann))\d*$/i;

const cases: [string, FormManifest][] = Object.entries(forms);

describe.each(cases)('manifest %s', (id, manifest) => {
  it('has matching id', () => {
    expect(manifest.id).toBe(id);
  });

  it('has at least one field', () => {
    expect(manifest.fields.length).toBeGreaterThan(0);
  });

  it('every field type is allowed', () => {
    for (const f of manifest.fields) {
      expect(ALLOWED_TYPES).toContain(f.type);
    }
  });

  it('every field name is a kebab-case slug', () => {
    for (const f of manifest.fields) {
      expect(f.name, `field name ${f.name}`).toMatch(SLUG_RE);
    }
  });

  it('no field has an empty label', () => {
    const empties = manifest.fields
      .filter((f) => !f.label || f.label.trim().length === 0)
      .map((f) => `${f.name} (pdfName=${f.pdfName})`);
    expect(empties, `fields with empty labels: ${empties.join(', ')}`).toEqual([]);
  });

  it('no slug matches generic pdf-default patterns', () => {
    const generic = manifest.fields
      .filter((f) => GENERIC_SLUG_RE.test(f.name))
      .map((f) => `${f.name} (pdfName=${f.pdfName})`);
    expect(generic, `generic slugs remain: ${generic.join(', ')}`).toEqual([]);
  });

  it('a slug never maps to two unrelated pdfNames at the same widget index', () => {
    // The manifest emits one entry per widget. The same slug may appear many
    // times — once per radio option, or once per page for a multi-page text
    // field, or as a synthetic radio Y/N pair (one slug, two pdfNames). What
    // must NOT happen is a slug colliding across rawNames where the entries
    // do not form a coherent radio pair.
    const slugToPdfNames = new Map<string, Set<string>>();
    const slugToTypes = new Map<string, Set<string>>();
    for (const f of manifest.fields) {
      const set = slugToPdfNames.get(f.name) ?? new Set<string>();
      set.add(f.pdfName);
      slugToPdfNames.set(f.name, set);
      const types = slugToTypes.get(f.name) ?? new Set<string>();
      types.add(f.type);
      slugToTypes.set(f.name, types);
    }
    for (const [slug, pdfNames] of slugToPdfNames) {
      if (pdfNames.size > 1) {
        // Multiple pdfNames are only acceptable if every entry under this slug
        // is part of a radio (synthetic Y/N pair).
        const types = slugToTypes.get(slug) ?? new Set();
        expect(
          [...types],
          `slug "${slug}" maps to multiple pdfNames [${[...pdfNames].join(', ')}] but is not a radio`,
        ).toEqual(['radio']);
      }
    }
  });

  it('options present iff type is dropdown or radio', () => {
    for (const f of manifest.fields) {
      const expectsOptions = f.type === 'dropdown' || f.type === 'radio';
      const hasOptions = Array.isArray(f.options) && f.options.length > 0;
      if (expectsOptions) {
        expect(hasOptions, `${f.name} (${f.type}) should have options`).toBe(true);
      } else {
        expect(hasOptions, `${f.name} (${f.type}) should NOT have options`).toBe(false);
      }
    }
  });

  it('rect is a 4-tuple of finite numbers, page is a non-negative integer', () => {
    for (const f of manifest.fields) {
      expect(f.rect).toHaveLength(4);
      for (const n of f.rect) expect(Number.isFinite(n)).toBe(true);
      expect(Number.isInteger(f.page)).toBe(true);
      expect(f.page).toBeGreaterThanOrEqual(0);
    }
  });

  it('radio fields have exactly one widget per declared option', () => {
    const radioGroups = new Map<string, { options: string[]; entries: typeof manifest.fields }>();
    for (const f of manifest.fields) {
      if (f.type !== 'radio') continue;
      const g = radioGroups.get(f.name) ?? { options: f.options ?? [], entries: [] };
      g.entries.push(f);
      radioGroups.set(f.name, g);
    }
    for (const [name, g] of radioGroups) {
      expect(g.options.length, `radio "${name}" has no options`).toBeGreaterThan(0);
      const seenOptions = new Set(g.entries.map((e) => e.option).filter(Boolean));
      expect(
        [...seenOptions].sort(),
        `radio "${name}" widget options [${[...seenOptions].join(', ')}] != declared options [${g.options.join(', ')}]`,
      ).toEqual([...g.options].sort());
    }
  });

  it('checkbox widgets on the same row never share a base slug with -1/-2 suffix instead of yes/no', () => {
    // Catches the pre-fix bug: two checkboxes on the same row sharing a base
    // slug because heuristic labels collided. After the fix they should be a
    // single radio with `option: yes`/`no`.
    const offenders: string[] = [];
    const byPage = new Map<number, typeof manifest.fields>();
    for (const f of manifest.fields) {
      if (f.type !== 'checkbox') continue;
      const arr = byPage.get(f.page) ?? [];
      arr.push(f);
      byPage.set(f.page, arr);
    }
    for (const list of byPage.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          const cyA = a.rect[1] + a.rect[3] / 2;
          const cyB = b.rect[1] + b.rect[3] / 2;
          if (Math.abs(cyA - cyB) > 3) continue;
          const baseA = a.name.replace(/-\d+$/, '');
          const baseB = b.name.replace(/-\d+$/, '');
          const suffixA = a.name.match(/-(\d+)$/)?.[1];
          const suffixB = b.name.match(/-(\d+)$/)?.[1];
          if (baseA === baseB && suffixA && suffixB && suffixA !== suffixB) {
            offenders.push(`${a.name} <-> ${b.name} on page ${a.page}`);
          }
        }
      }
    }
    expect(offenders, `checkbox row pairs with -N suffixes: ${offenders.join(' | ')}`).toEqual([]);
  });
});
