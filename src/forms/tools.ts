import { AGENCY_FIELD_MAP, AGENCY_PROFILE } from './agency-profile';
import type { ApplicationAnswers, FormFieldDef, FormManifest } from './types';

export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const FORM_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_unfilled_fields',
      description: 'List form fields that are still empty or unset.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fields',
      description: 'Read the current values of one or more fields.',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' } },
        },
        required: ['names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_fields',
      description:
        'Write values into one or more fields. For checkboxes use boolean; for dropdown/radio use one of the option strings.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: {},
              },
              required: ['name', 'value'],
            },
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prefill_agency_info',
      description:
        "Fill the broker's own agency info block (name, address, city, state, zip, phone, fax, email, code) from the stored agency profile. Use when the broker asks to add/fill agency or agent info. Skips fields that already have a non-empty value — those are returned as `skipped` so you can confirm before overwriting via set_fields.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export type FieldValue = string | boolean | null;

export interface ToolExecutionResult {
  result: unknown;
  updates?: Record<string, FieldValue>;
}

function isFilled(v: FieldValue | undefined): boolean {
  if (v === true) return true;
  if (typeof v === 'string' && v.length > 0) return true;
  return false;
}

function indexFields(manifest: FormManifest): Map<string, FormFieldDef[]> {
  const m = new Map<string, FormFieldDef[]>();
  for (const f of manifest.fields) {
    const arr = m.get(f.name) ?? [];
    arr.push(f);
    m.set(f.name, arr);
  }
  return m;
}

function coerceValue(
  defs: FormFieldDef[],
  rawValue: unknown,
): { value: FieldValue } | { error: string } {
  const def = defs[0];
  if (def.type === 'checkbox') {
    if (typeof rawValue === 'boolean') return { value: rawValue };
    if (rawValue === null) return { value: false };
    if (typeof rawValue === 'string') {
      const s = rawValue.toLowerCase();
      if (['true', 'yes', '1', 'on', 'checked'].includes(s)) return { value: true };
      if (['false', 'no', '0', 'off', 'unchecked', ''].includes(s)) return { value: false };
    }
    return { error: `expected boolean for checkbox, got ${JSON.stringify(rawValue)}` };
  }
  if (def.type === 'dropdown') {
    if (rawValue === null || rawValue === '') return { value: null };
    if (typeof rawValue !== 'string')
      return { error: `expected string for dropdown, got ${JSON.stringify(rawValue)}` };
    if (def.options && !def.options.includes(rawValue)) {
      return {
        error: `value ${JSON.stringify(rawValue)} not in options [${def.options.join(', ')}]`,
      };
    }
    return { value: rawValue };
  }
  if (def.type === 'radio') {
    if (rawValue === null || rawValue === '') return { value: null };
    if (typeof rawValue !== 'string')
      return { error: `expected string for radio, got ${JSON.stringify(rawValue)}` };
    const allowed = new Set<string>();
    for (const d of defs) {
      if (d.option) allowed.add(d.option);
      d.options?.forEach((o) => allowed.add(o));
    }
    if (allowed.size > 0 && !allowed.has(rawValue)) {
      return {
        error: `value ${JSON.stringify(rawValue)} not in options [${[...allowed].join(', ')}]`,
      };
    }
    return { value: rawValue };
  }
  // text / signature
  if (rawValue === null) return { value: null };
  if (typeof rawValue === 'string') return { value: rawValue };
  if (typeof rawValue === 'number' || typeof rawValue === 'boolean')
    return { value: String(rawValue) };
  return { error: `expected string for text field, got ${JSON.stringify(rawValue)}` };
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  manifest: FormManifest,
  answers: ApplicationAnswers,
): ToolExecutionResult {
  const fieldIndex = indexFields(manifest);

  if (name === 'list_unfilled_fields') {
    const unfilled: { name: string; type: string; label: string; options?: string[] }[] = [];
    const seen = new Set<string>();
    for (const f of manifest.fields) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      if (!isFilled(answers[f.name])) {
        unfilled.push({
          name: f.name,
          type: f.type,
          label: f.label,
          ...(f.options ? { options: f.options } : {}),
        });
      }
    }
    return { result: { count: unfilled.length, fields: unfilled } };
  }

  if (name === 'get_fields') {
    const names = Array.isArray(args.names) ? (args.names as unknown[]) : [];
    const values: Record<string, FieldValue | null> = {};
    const unknown: string[] = [];
    for (const n of names) {
      if (typeof n !== 'string') continue;
      if (!fieldIndex.has(n)) {
        unknown.push(n);
        continue;
      }
      values[n] = answers[n] ?? null;
    }
    return { result: { values, ...(unknown.length ? { unknown } : {}) } };
  }

  if (name === 'set_fields') {
    const rawUpdates = Array.isArray(args.updates) ? (args.updates as unknown[]) : [];
    const applied: { name: string; value: FieldValue }[] = [];
    const errors: { name: string; error: string }[] = [];
    const updates: Record<string, FieldValue> = {};
    for (const item of rawUpdates) {
      if (!item || typeof item !== 'object') {
        errors.push({ name: '', error: 'invalid update entry' });
        continue;
      }
      const n = (item as { name?: unknown }).name;
      const v = (item as { value?: unknown }).value;
      if (typeof n !== 'string') {
        errors.push({ name: '', error: 'missing field name' });
        continue;
      }
      const defs = fieldIndex.get(n);
      if (!defs) {
        errors.push({ name: n, error: 'unknown field' });
        continue;
      }
      const coerced = coerceValue(defs, v);
      if ('error' in coerced) {
        errors.push({ name: n, error: coerced.error });
        continue;
      }
      updates[n] = coerced.value;
      applied.push({ name: n, value: coerced.value });
    }
    return {
      result: {
        applied,
        ...(errors.length ? { errors } : {}),
      },
      updates,
    };
  }

  if (name === 'prefill_agency_info') {
    const mapping = AGENCY_FIELD_MAP[manifest.id];
    if (!mapping) {
      return {
        result: {
          supported: false,
          formId: manifest.id,
          message: 'No agency profile mapping for this form. Use set_fields instead.',
        },
      };
    }
    const applied: { name: string; value: string }[] = [];
    const skipped: { name: string; existing: FieldValue }[] = [];
    const updates: Record<string, FieldValue> = {};
    for (const [profileKey, fieldNames] of Object.entries(mapping)) {
      const value = AGENCY_PROFILE[profileKey as keyof typeof AGENCY_PROFILE];
      if (!value) continue;
      for (const n of fieldNames ?? []) {
        if (!fieldIndex.has(n)) continue;
        if (isFilled(answers[n])) {
          skipped.push({ name: n, existing: answers[n] ?? null });
          continue;
        }
        updates[n] = value;
        applied.push({ name: n, value });
      }
    }
    return {
      result: { applied, ...(skipped.length ? { skipped } : {}) },
      updates,
    };
  }

  return { result: { error: `unknown tool: ${name}` } };
}
