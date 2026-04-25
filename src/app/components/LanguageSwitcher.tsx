import { useTranslation } from 'react-i18next';

const LOCALES = ['en', 'es', 'de'] as const;
type Locale = (typeof LOCALES)[number];

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (LOCALES.find((l) => i18n.resolvedLanguage === l) ?? 'en') as Locale;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Locale;
    void i18n.changeLanguage(next);
    document.documentElement.lang = next;
  };

  return (
    <select
      aria-label={t('language.label')}
      value={current}
      onChange={onChange}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 hover:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-500"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {t(`language.${l}`)}
        </option>
      ))}
    </select>
  );
}
