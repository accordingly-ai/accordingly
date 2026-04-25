import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FormView } from './FormView';
import { LanguageSwitcher } from './components/LanguageSwitcher';

interface FormSummary {
  id: string;
  title: string;
  fieldCount: number;
}

function Home() {
  const { t } = useTranslation();
  const [list, setList] = useState<FormSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/forms')
      .then((r) => r.json() as Promise<FormSummary[]>)
      .then(setList)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-8">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-semibold">{t('app.title')}</h1>
        <p className="mt-2 text-neutral-400">{t('app.tagline')}</p>
        <h2 className="mt-8 text-xl font-semibold">{t('home.formsHeading')}</h2>
        {error && <p className="text-red-400 mt-2">{error}</p>}
        <ul className="mt-4 space-y-2">
          {list?.map((f) => (
            <li key={f.id}>
              <Link to={`/forms/${f.id}`} className="text-blue-400 hover:underline">
                {f.title}
              </Link>
              <span className="text-neutral-500 ml-2">
                ({t('home.fieldCount', { count: f.fieldCount })})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/forms/:id" element={<FormView />} />
    </Routes>
  );
}
