import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { forms } from '../../forms';
import { LanguageSwitcher } from './LanguageSwitcher';
import { Logo } from './Logo';

export function AppShell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const formList = Object.values(forms);

  return (
    <div className="h-screen bg-neutral-900 text-neutral-100 flex">
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 bg-neutral-950 border-r border-neutral-800 flex flex-col transform transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0 lg:static lg:z-0`}
      >
        <div className="px-5 py-5 flex items-center gap-2 border-b border-neutral-800">
          <Logo className="h-6 w-6 text-neutral-200" />
          <span className="text-lg font-semibold tracking-tight">{t('app.title')}</span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {t('nav.forms')}
          </div>
          <ul className="space-y-1">
            {formList.map((f) => (
              <li key={f.id}>
                <NavLink
                  to={`/forms/${f.id}`}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-neutral-800 text-blue-400'
                        : 'text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100'
                    }`
                  }
                >
                  {f.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-neutral-800 px-3 py-3">
          <LanguageSwitcher />
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle navigation"
          className="lg:hidden absolute top-3 left-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950/90 text-neutral-200 hover:bg-neutral-800"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <main className="flex-1 min-h-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
