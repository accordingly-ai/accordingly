import { describe, expect, it } from 'vitest';
import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from 'pdf-lib';
import {
  bestLabelFor,
  classify,
  normalizeOverrides,
  pairYesNo,
  slugFromRawName,
  slugifyText,
} from './extract-acord-fields';

describe('slugifyText', () => {
  it('lowercases and replaces non-alphanumerics with single dashes', () => {
    expect(slugifyText('Business Name')).toBe('business-name');
    expect(slugifyText('Producer / Agent — A')).toBe('producer-agent-a');
  });

  it('strips leading/trailing dashes', () => {
    expect(slugifyText(' --Hello-- ')).toBe('hello');
  });

  it('returns empty string for non-alphanumeric input', () => {
    expect(slugifyText('!!!')).toBe('');
  });
});

describe('slugFromRawName', () => {
  it('breaks CamelCase into kebab-case', () => {
    expect(slugFromRawName('ProducerFullName')).toBe('producer-full-name');
  });

  it('treats underscores as separators', () => {
    expect(slugFromRawName('Producer_Full_Name')).toBe('producer-full-name');
  });

  it('strips trailing single-letter ACORD suffix', () => {
    expect(slugFromRawName('ProducerFullName_A')).toBe('producer-full-name');
    expect(slugFromRawName('Foo_b')).toBe('foo');
  });

  it('handles consecutive uppercase runs (acronyms)', () => {
    expect(slugFromRawName('NAICCode')).toBe('naic-code');
  });

  it('collapses redundant dashes', () => {
    expect(slugFromRawName('Foo__Bar---Baz')).toBe('foo-bar-baz');
  });
});

describe('classify', () => {
  // Use Object.create so we don't need to construct full pdf-lib instances
  // (their constructors are private).
  const make = (ctor: { prototype: object }) => Object.create(ctor.prototype);

  it('detects each pdf-lib field subtype', () => {
    expect(classify(make(PDFTextField))).toBe('text');
    expect(classify(make(PDFCheckBox))).toBe('checkbox');
    expect(classify(make(PDFRadioGroup))).toBe('radio');
    expect(classify(make(PDFDropdown))).toBe('dropdown');
    expect(classify(make(PDFOptionList))).toBe('dropdown');
    expect(classify(make(PDFSignature))).toBe('signature');
  });

  it('falls back to text for unknown shapes', () => {
    expect(classify({})).toBe('text');
    expect(classify(null)).toBe('text');
  });
});

describe('pairYesNo', () => {
  type Cand = Parameters<typeof pairYesNo>[0][number];
  const cb = (
    rawName: string,
    page: number,
    x: number,
    y: number,
    label: string,
    w = 12,
    h = 11,
  ): Cand => ({
    rawName,
    widgetIdx: 0,
    page,
    rect: [x, y, w, h],
    label,
  });

  it('pairs adjacent same-label checkboxes left=yes, right=no', () => {
    const pairs = pairYesNo([
      cb('Y', 0, 281, 174, 'QUESTION'),
      cb('N', 0, 296, 174, 'QUESTION'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].yes.rawName).toBe('Y');
    expect(pairs[0].no.rawName).toBe('N');
    expect(pairs[0].slug).toBe('question');
    expect(pairs[0].label).toBe('QUESTION');
  });

  it('does not pair when horizontal gap exceeds 22 pt', () => {
    const pairs = pairYesNo([
      cb('A', 0, 281, 174, 'QUESTION'),
      cb('B', 0, 562, 174, 'QUESTION'),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('emits two pairs on one row (left + right column) and bumps slug suffix downstream via uniquify, not here', () => {
    // pairYesNo itself emits both pairs with the same slug; the suffix is
    // applied later by uniquifyGroups. We only assert two pairs were detected.
    const pairs = pairYesNo([
      cb('LY', 0, 281, 174, 'Q'),
      cb('LN', 0, 296, 174, 'Q'),
      cb('RY', 0, 562, 174, 'Q'),
      cb('RN', 0, 577, 174, 'Q'),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].yes.rawName).toBe('LY');
    expect(pairs[1].yes.rawName).toBe('RY');
  });

  it('does not pair when widgets are vertically misaligned (>3 pt)', () => {
    const pairs = pairYesNo([
      cb('A', 0, 281, 174, 'QUESTION'),
      cb('B', 0, 296, 168, 'QUESTION'),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('does not pair when the heuristic labels differ', () => {
    const pairs = pairYesNo([
      cb('A', 0, 281, 174, 'INSIDE'),
      cb('B', 0, 296, 174, 'OUTSIDE'),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('does not pair when both labels are empty', () => {
    const pairs = pairYesNo([
      cb('A', 0, 281, 174, ''),
      cb('B', 0, 296, 174, ''),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('returns no pairs on empty input', () => {
    expect(pairYesNo([])).toEqual([]);
  });
});

describe('normalizeOverrides', () => {
  const rawFields = [
    {
      rawName: 'agentcity',
      type: 'text' as const,
      tu: null,
      widgets: [
        { rect: [0, 0, 1, 1] as [number, number, number, number], page: 0 },
        { rect: [0, 0, 1, 1] as [number, number, number, number], page: 2 },
        { rect: [0, 0, 1, 1] as [number, number, number, number], page: 4 },
      ],
    },
    {
      rawName: 'applicantsname',
      type: 'text' as const,
      tu: null,
      widgets: [{ rect: [0, 0, 1, 1] as [number, number, number, number], page: 0 }],
    },
  ];

  it('expands legacy form to all widgets of the rawName', () => {
    const out = normalizeOverrides(
      { applicantsname: { name: 'applicant-name', label: 'APPLICANT NAME' } },
      rawFields,
    );
    expect(out.byKey.get('applicantsname#0')?.name).toBe('applicant-name');
    expect(out.splitRawNames.has('applicantsname')).toBe(false);
  });

  it('expands widgets[] form by index', () => {
    const out = normalizeOverrides(
      {
        agentcity: {
          widgets: [
            { name: 'a', label: 'A' },
            { name: 'b', label: 'B' },
            { name: 'c', label: 'C' },
          ],
        },
      },
      rawFields,
    );
    expect(out.byKey.get('agentcity#0')?.name).toBe('a');
    expect(out.byKey.get('agentcity#1')?.name).toBe('b');
    expect(out.byKey.get('agentcity#2')?.name).toBe('c');
    expect(out.splitRawNames.has('agentcity')).toBe(true);
  });

  it('expands byPage form by matching page → widgetIdx', () => {
    const out = normalizeOverrides(
      {
        agentcity: {
          byPage: {
            '0': { name: 'agency-city', label: 'AGENCY CITY' },
            '2': { name: 'agency-city-2', label: 'AGENCY CITY' },
            '4': { name: 'agency-city-3', label: 'AGENCY CITY' },
          },
        },
      },
      rawFields,
    );
    expect(out.byKey.get('agentcity#0')?.name).toBe('agency-city');
    expect(out.byKey.get('agentcity#1')?.name).toBe('agency-city-2');
    expect(out.byKey.get('agentcity#2')?.name).toBe('agency-city-3');
  });

  it('rejects mixing legacy with widgets/byPage', () => {
    expect(() =>
      normalizeOverrides(
        {
          agentcity: {
            name: 'x',
            widgets: [{ name: 'y' }, { name: 'z' }, { name: 'w' }],
          } as never,
        },
        rawFields,
      ),
    ).toThrow();
  });

  it('rejects widgets[] length mismatch', () => {
    expect(() =>
      normalizeOverrides(
        { agentcity: { widgets: [{ name: 'only-one' }] } },
        rawFields,
      ),
    ).toThrow();
  });

  it('rejects byPage entries with no matching widget page', () => {
    expect(() =>
      normalizeOverrides(
        { agentcity: { byPage: { '7': { name: 'x' } } } },
        rawFields,
      ),
    ).toThrow();
  });
});

describe('bestLabelFor', () => {
  const widget = { rect: [100, 100, 50, 12] as [number, number, number, number], page: 0 };

  it('finds a label inside the narrow above-window', () => {
    const items = [
      { str: 'NAME', x: 100, y: 120, width: 30, height: 10 },
    ];
    expect(bestLabelFor(widget, items)).toBe('NAME');
  });

  it('falls back to the widened left-window when narrow modes find nothing', () => {
    // 100 pt to the left, beyond the narrow leftMax of 80.
    const items = [
      { str: 'AGENCY CITY', x: -10, y: 105, width: 60, height: 10 },
    ];
    expect(bestLabelFor(widget, items)).toBe('AGENCY CITY');
  });

  it('does not regress: a narrow-window hit still wins over a widened candidate', () => {
    const items = [
      // narrow above hit
      { str: 'NAME', x: 100, y: 120, width: 30, height: 10 },
      // widened left hit
      { str: 'OTHER', x: -10, y: 105, width: 60, height: 10 },
    ];
    expect(bestLabelFor(widget, items)).toBe('NAME');
  });

  it('returns null when nothing useful is in range', () => {
    expect(bestLabelFor(widget, [])).toBeNull();
  });
});
