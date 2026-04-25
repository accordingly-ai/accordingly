export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature';

export interface FormFieldDef {
  name: string;
  type: FormFieldType;
  label: string;
  page: number;
  rect: [number, number, number, number];
  options?: string[];
  /** For an individual radio-group widget: the option value this widget represents. */
  option?: string;
  maxLength?: number;
}

export interface FormManifest {
  id: string;
  title: string;
  fields: FormFieldDef[];
}

export type ApplicationAnswers = Record<string, string | boolean | null>;
