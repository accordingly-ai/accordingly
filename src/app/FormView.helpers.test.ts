import { beforeEach, describe, expect, it } from 'vitest';
import type { FormFieldDef } from '../forms/types';
import { fieldStyle, formatSavedAgo, loadLocalAnswers, type PageMeta } from './FormView';

describe('formatSavedAgo', () => {
  const now = 1_700_000_000_000;

  it('returns null when nothing has been saved', () => {
    expect(formatSavedAgo(null, now)).toBeNull();
  });

  it('returns the just-now key within 5 seconds', () => {
    expect(formatSavedAgo(now - 1_000, now)).toEqual({ key: 'form.savedJustNow' });
    expect(formatSavedAgo(now - 4_400, now)).toEqual({ key: 'form.savedJustNow' });
  });

  it('reports seconds for sub-minute deltas', () => {
    expect(formatSavedAgo(now - 30_000, now)).toEqual({ key: 'form.savedSeconds', count: 30 });
  });

  it('reports minutes for sub-hour deltas', () => {
    expect(formatSavedAgo(now - 5 * 60_000, now)).toEqual({ key: 'form.savedMinutes', count: 5 });
  });

  it('reports hours for hour-plus deltas', () => {
    expect(formatSavedAgo(now - 3 * 60 * 60_000, now)).toEqual({ key: 'form.savedHours', count: 3 });
  });

  it('clamps negative deltas (clock skew) to the just-now key', () => {
    expect(formatSavedAgo(now + 1_000, now)).toEqual({ key: 'form.savedJustNow' });
  });
});

describe('fieldStyle', () => {
  const field: FormFieldDef = {
    name: 'x',
    pdfName: 'X',
    type: 'text',
    label: 'X',
    page: 0,
    rect: [10, 20, 100, 30],
  };

  it('flips PDF coordinates (origin at bottom-left) into CSS coordinates (top-left) and applies the page scale', () => {
    const meta: PageMeta = { width: 1100, height: 850, scale: 2 };
    const style = fieldStyle(field, meta);
    expect(style.position).toBe('absolute');
    // x * scale
    expect(style.left).toBe('20px');
    // height - (y + h) * scale -> 850 - (20 + 30) * 2 = 750
    expect(style.top).toBe('750px');
    // w * scale, h * scale
    expect(style.width).toBe('200px');
    expect(style.height).toBe('60px');
  });
});

describe('loadLocalAnswers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns {} when no answers are stored', () => {
    expect(loadLocalAnswers('acord-125')).toEqual({});
  });

  it('reads JSON-serialized answers from localStorage under the namespaced key', () => {
    localStorage.setItem(
      'accordingly:answers:acord-125',
      JSON.stringify({ 'business-name': 'Acme' }),
    );
    expect(loadLocalAnswers('acord-125')).toEqual({ 'business-name': 'Acme' });
  });

  it('returns {} on malformed JSON instead of throwing', () => {
    localStorage.setItem('accordingly:answers:acord-125', '{not json');
    expect(loadLocalAnswers('acord-125')).toEqual({});
  });
});
