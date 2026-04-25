import { describe, expect, it } from 'vitest';
import { executeTool } from './tools';
import type { FormManifest } from './types';

const manifest: FormManifest = {
  id: 'test-form',
  title: 'Test Form',
  fields: [
    {
      name: 'business-name',
      pdfName: 'BusinessName',
      type: 'text',
      label: 'Business Name',
      page: 0,
      rect: [0, 0, 10, 10],
      maxLength: 50,
    },
    {
      name: 'has-employees',
      pdfName: 'HasEmployees',
      type: 'checkbox',
      label: 'Has Employees',
      page: 0,
      rect: [0, 0, 10, 10],
    },
    {
      name: 'state',
      pdfName: 'State',
      type: 'dropdown',
      label: 'State',
      page: 0,
      rect: [0, 0, 10, 10],
      options: ['NY', 'CA', 'TX'],
    },
    {
      name: 'entity-type',
      pdfName: 'Entity1',
      type: 'radio',
      label: 'Entity Type',
      page: 0,
      rect: [0, 0, 10, 10],
      options: ['LLC', 'Corp', 'Sole Prop'],
      option: 'LLC',
    },
    {
      name: 'entity-type',
      pdfName: 'Entity2',
      type: 'radio',
      label: 'Entity Type',
      page: 0,
      rect: [10, 0, 10, 10],
      options: ['LLC', 'Corp', 'Sole Prop'],
      option: 'Corp',
    },
    {
      name: 'entity-type',
      pdfName: 'Entity3',
      type: 'radio',
      label: 'Entity Type',
      page: 0,
      rect: [20, 0, 10, 10],
      options: ['LLC', 'Corp', 'Sole Prop'],
      option: 'Sole Prop',
    },
  ],
};

describe('executeTool: list_unfilled_fields', () => {
  it('returns every distinct field when nothing is filled', () => {
    const r = executeTool('list_unfilled_fields', {}, manifest, {});
    const result = r.result as { count: number; fields: { name: string }[] };
    expect(result.count).toBe(4);
    expect(result.fields.map((f) => f.name)).toEqual([
      'business-name',
      'has-employees',
      'state',
      'entity-type',
    ]);
  });

  it('treats true/non-empty-string as filled and false/empty as unfilled', () => {
    const r = executeTool('list_unfilled_fields', {}, manifest, {
      'business-name': '',
      'has-employees': false,
      'state': 'NY',
      'entity-type': 'LLC',
    });
    const fields = (r.result as { fields: { name: string }[] }).fields.map((f) => f.name);
    expect(fields).toEqual(['business-name', 'has-employees']);
  });

  it('includes options for choice fields', () => {
    const r = executeTool('list_unfilled_fields', {}, manifest, {});
    const stateField = (r.result as { fields: { name: string; options?: string[] }[] }).fields.find(
      (f) => f.name === 'state',
    );
    expect(stateField?.options).toEqual(['NY', 'CA', 'TX']);
  });
});

describe('executeTool: get_fields', () => {
  it('returns current values for known names', () => {
    const r = executeTool(
      'get_fields',
      { names: ['business-name', 'has-employees'] },
      manifest,
      { 'business-name': 'Acme', 'has-employees': true },
    );
    expect(r.result).toEqual({
      values: { 'business-name': 'Acme', 'has-employees': true },
    });
  });

  it('reports unknown names separately and returns null for unset known fields', () => {
    const r = executeTool(
      'get_fields',
      { names: ['business-name', 'mystery'] },
      manifest,
      {},
    );
    expect(r.result).toEqual({
      values: { 'business-name': null },
      unknown: ['mystery'],
    });
  });

  it('ignores non-string entries in names', () => {
    const r = executeTool(
      'get_fields',
      { names: ['business-name', 42, null] },
      manifest,
      { 'business-name': 'Acme' },
    );
    expect((r.result as { values: Record<string, unknown> }).values).toEqual({
      'business-name': 'Acme',
    });
  });

  it('handles missing/non-array `names`', () => {
    const r = executeTool('get_fields', {}, manifest, {});
    expect(r.result).toEqual({ values: {} });
  });
});

describe('executeTool: set_fields', () => {
  it('applies a batch of valid updates and emits aggregate updates map', () => {
    const r = executeTool(
      'set_fields',
      {
        updates: [
          { name: 'business-name', value: 'Acme Coffee LLC' },
          { name: 'has-employees', value: true },
          { name: 'state', value: 'NY' },
          { name: 'entity-type', value: 'LLC' },
        ],
      },
      manifest,
      {},
    );
    const result = r.result as { applied: { name: string; value: unknown }[] };
    expect(result.applied).toHaveLength(4);
    expect(r.updates).toEqual({
      'business-name': 'Acme Coffee LLC',
      'has-employees': true,
      'state': 'NY',
      'entity-type': 'LLC',
    });
  });

  it('coerces string truthy/falsy for checkboxes', () => {
    const r = executeTool(
      'set_fields',
      {
        updates: [
          { name: 'has-employees', value: 'yes' },
        ],
      },
      manifest,
      {},
    );
    expect(r.updates).toEqual({ 'has-employees': true });

    const r2 = executeTool(
      'set_fields',
      { updates: [{ name: 'has-employees', value: 'no' }] },
      manifest,
      {},
    );
    expect(r2.updates).toEqual({ 'has-employees': false });

    const r3 = executeTool(
      'set_fields',
      { updates: [{ name: 'has-employees', value: null }] },
      manifest,
      {},
    );
    expect(r3.updates).toEqual({ 'has-employees': false });
  });

  it('rejects non-coercible checkbox values', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'has-employees', value: 42 }] },
      manifest,
      {},
    );
    const result = r.result as { errors?: { name: string; error: string }[] };
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].name).toBe('has-employees');
    expect(r.updates).toEqual({});
  });

  it('rejects dropdown values not in options', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'state', value: 'ZZ' }] },
      manifest,
      {},
    );
    const result = r.result as { errors?: { name: string; error: string }[] };
    expect(result.errors?.[0].error).toContain('not in options');
    expect(r.updates).toEqual({});
  });

  it('clears dropdown with null/empty string', () => {
    const rNull = executeTool(
      'set_fields',
      { updates: [{ name: 'state', value: null }] },
      manifest,
      { state: 'NY' },
    );
    expect(rNull.updates).toEqual({ state: null });
    const rEmpty = executeTool(
      'set_fields',
      { updates: [{ name: 'state', value: '' }] },
      manifest,
      { state: 'NY' },
    );
    expect(rEmpty.updates).toEqual({ state: null });
  });

  it('accepts radio values from any widget option in the group', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'entity-type', value: 'Corp' }] },
      manifest,
      {},
    );
    expect(r.updates).toEqual({ 'entity-type': 'Corp' });
  });

  it('rejects radio values not in the group', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'entity-type', value: 'Partnership' }] },
      manifest,
      {},
    );
    const result = r.result as { errors?: { error: string }[] };
    expect(result.errors?.[0].error).toContain('not in options');
  });

  it('reports unknown field names', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'mystery', value: 'x' }] },
      manifest,
      {},
    );
    const result = r.result as { errors?: { error: string }[] };
    expect(result.errors?.[0].error).toBe('unknown field');
  });

  it('coerces numbers/booleans into text strings', () => {
    const r = executeTool(
      'set_fields',
      {
        updates: [
          { name: 'business-name', value: 42 },
        ],
      },
      manifest,
      {},
    );
    expect(r.updates).toEqual({ 'business-name': '42' });
  });

  it('clears text field with null', () => {
    const r = executeTool(
      'set_fields',
      { updates: [{ name: 'business-name', value: null }] },
      manifest,
      { 'business-name': 'old' },
    );
    expect(r.updates).toEqual({ 'business-name': null });
  });

  it('skips invalid update entries while preserving valid ones', () => {
    const r = executeTool(
      'set_fields',
      {
        updates: [
          'not-an-object',
          { /* missing name */ value: 'x' },
          { name: 'business-name', value: 'kept' },
        ],
      },
      manifest,
      {},
    );
    const result = r.result as { applied: unknown[]; errors?: unknown[] };
    expect(result.applied).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(r.updates).toEqual({ 'business-name': 'kept' });
  });
});

describe('executeTool: unknown tool', () => {
  it('returns an error result without throwing', () => {
    const r = executeTool('does_not_exist', {}, manifest, {});
    expect(r.result).toEqual({ error: 'unknown tool: does_not_exist' });
  });
});
