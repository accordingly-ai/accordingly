import { describe, expect, it } from 'vitest';
import { forms } from './index';
import type { FormFieldType, FormManifest } from './types';

const ALLOWED_TYPES: FormFieldType[] = ['text', 'checkbox', 'radio', 'dropdown', 'signature'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

  it('field names map 1:1 with pdfName (one logical field per slug)', () => {
    // The manifest emits one entry per widget, so the same `name` can appear
    // many times — once per radio option, or once per page for a multi-page
    // text field. What must NOT happen is two unrelated pdf fields colliding
    // on the same slug.
    const slugToPdfNames = new Map<string, Set<string>>();
    for (const f of manifest.fields) {
      const set = slugToPdfNames.get(f.name) ?? new Set<string>();
      set.add(f.pdfName);
      slugToPdfNames.set(f.name, set);
    }
    const collisions = [...slugToPdfNames.entries()]
      .filter(([, s]) => s.size > 1)
      .map(([k, s]) => `${k} -> ${[...s].join(', ')}`);
    expect(collisions, `slug collisions: ${collisions.join(' | ')}`).toEqual([]);
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
});
