import { Route, Routes } from 'react-router';

function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-4xl font-semibold">Accordingly</h1>
        <p className="mt-2 text-neutral-400">Coordinator</p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
