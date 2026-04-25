import acord125Es from '../forms/locales/acord-125.es.json';
import acord125De from '../forms/locales/acord-125.de.json';
import acord126Es from '../forms/locales/acord-126.es.json';
import acord126De from '../forms/locales/acord-126.de.json';

type LabelMap = Record<string, string>;

const REGISTRY: Record<string, Record<string, LabelMap>> = {
  'acord-125': { es: acord125Es, de: acord125De },
  'acord-126': { es: acord126Es, de: acord126De },
};

export function resolveFieldLabel(
  formId: string,
  fieldName: string,
  englishLabel: string,
  language: string | undefined,
): string {
  if (!language) return englishLabel;
  const lang = language.split('-')[0];
  const translated = REGISTRY[formId]?.[lang]?.[fieldName];
  return translated ?? englishLabel;
}
