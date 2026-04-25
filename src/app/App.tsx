import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import { FormView } from './FormView';

interface FormSummary {
  id: string;
  title: string;
  fieldCount: number;
}

function Home() {
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
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-semibold">Accordingly</h1>
        <p className="mt-2 text-neutral-400">
          Iterative form-filling agent for commercial insurance.
        </p>
        <h2 className="mt-8 text-xl font-semibold">Forms</h2>
        {error && <p className="text-red-400 mt-2">{error}</p>}
        <ul className="mt-4 space-y-2">
          {list?.map((f) => (
            <li key={f.id}>
              <Link to={`/forms/${f.id}`} className="text-blue-400 hover:underline">
                {f.title}
              </Link>
              <span className="text-neutral-500 ml-2">({f.fieldCount} fields)</span>
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
