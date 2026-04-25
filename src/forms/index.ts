import acord125 from './acord-125.json' with { type: 'json' };
import acord126 from './acord-126.json' with { type: 'json' };
import type { FormManifest } from './types';

export const forms: Record<string, FormManifest> = {
  'acord-125': acord125 as FormManifest,
  'acord-126': acord126 as FormManifest,
};

export type {
  FormManifest,
  FormFieldDef,
  FormFieldType,
  ApplicationAnswers,
  FormDraft,
  SessionState,
} from './types';
