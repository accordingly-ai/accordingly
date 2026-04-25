import { describe, expect, it } from 'vitest';
import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from 'pdf-lib';
import { classify, slugFromRawName, slugifyText } from './extract-acord-fields';

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
