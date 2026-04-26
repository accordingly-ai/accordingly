import { Navigate, Route, Routes } from 'react-router';
import { FormView } from './FormView';
import { AppShell } from './components/AppShell';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/forms/acord-125" replace />} />
        <Route path="forms/:id" element={<FormView />} />
      </Route>
    </Routes>
  );
}
