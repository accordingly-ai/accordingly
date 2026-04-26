import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type {
  ApplicationAnswers,
  FormFieldDef,
  FormManifest,
  SessionState,
} from '../forms/types';
import { ChatPanel } from './ChatPanel';

export interface PageMeta {
  /** scaled width in CSS px */
  width: number;
  /** scaled height in CSS px */
  height: number;
  /** scale factor from PDF user units to CSS px */
  scale: number;
}

const TARGET_PAGE_WIDTH = 1100;

function answersStorageKey(formId: string) {
  return `accordingly:answers:${formId}`;
}

export function loadLocalAnswers(formId: string): ApplicationAnswers {
  try {
    const raw = localStorage.getItem(answersStorageKey(formId));
    return raw ? (JSON.parse(raw) as ApplicationAnswers) : {};
  } catch {
    return {};
  }
}

export function formatSavedAgo(savedAt: number | null, now: number): string | null {
  if (savedAt === null) return null;
  const secs = Math.max(0, Math.round((now - savedAt) / 1000));
  if (secs < 5) return 'saved just now';
  if (secs < 60) return `saved ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `saved ${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `saved ${hours}h ago`;
}

export function fieldStyle(field: FormFieldDef, meta: PageMeta): React.CSSProperties {
  const [x, y, w, h] = field.rect;
  const s = meta.scale;
  return {
    position: 'absolute',
    left: `${x * s}px`,
    top: `${meta.height - (y + h) * s}px`,
    width: `${w * s}px`,
    height: `${h * s}px`,
  };
}

function FieldInput({
  field,
  meta,
  value,
  onChange,
}: {
  field: FormFieldDef;
  meta: PageMeta;
  value: string | boolean | null | undefined;
  onChange: (next: string | boolean | null) => void;
}) {
  const style = fieldStyle(field, meta);
  const title = `${field.label} (${field.name})`;
  const isFilled = value === true || (typeof value === 'string' && value.length > 0);

  if (field.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        title={title}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          ...style,
          margin: 0,
          accentColor: '#2563eb',
          cursor: 'pointer',
        }}
      />
    );
  }

  if (field.type === 'dropdown') {
    return (
      <select
        title={title}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...style,
          fontSize: `${Math.max(10, meta.scale * 9)}px`,
          padding: '0 2px',
          border: isFilled ? '1px solid rgba(147, 197, 253, 0.35)' : '1px solid #93c5fd',
          background: isFilled ? 'rgba(219, 234, 254, 0.10)' : 'rgba(219, 234, 254, 0.45)',
          color: '#0f172a',
          boxSizing: 'border-box',
        }}
      >
        <option value=""></option>
        {field.options?.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'radio' && field.option !== undefined) {
    return (
      <input
        type="radio"
        title={`${title} = ${field.option}`}
        name={field.name}
        value={field.option}
        checked={value === field.option}
        onChange={() => onChange(field.option ?? null)}
        style={{ ...style, margin: 0, accentColor: '#2563eb', cursor: 'pointer' }}
      />
    );
  }

  // text / signature / fallback
  return (
    <input
      type="text"
      title={title}
      value={typeof value === 'string' ? value : ''}
      maxLength={field.maxLength}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.type === 'signature' ? '(signature)' : ''}
      style={{
        ...style,
        fontSize: `${Math.max(10, meta.scale * 9)}px`,
        padding: '0 2px',
        border: isFilled ? '1px solid rgba(147, 197, 253, 0.35)' : '1px solid #93c5fd',
        background: isFilled ? 'rgba(219, 234, 254, 0.08)' : 'rgba(219, 234, 254, 0.35)',
        color: '#0f172a',
        boxSizing: 'border-box',
      }}
    />
  );
}

export function FormView() {
  const { id } = useParams<{ id: string }>();
  const [manifest, setManifest] = useState<FormManifest | null>(null);
  const [answers, setAnswers] = useState<ApplicationAnswers>({});
  const [answersLoaded, setAnswersLoaded] = useState(false);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [renderedPages, setRenderedPages] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());

  // Load manifest.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/forms/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as FormManifest;
      })
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Hydrate answers: GET /api/session, fall back to local mirror so an
  // in-flight session isn't lost on first deploy.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setAnswersLoaded(false);
    (async () => {
      const local = loadLocalAnswers(id);
      try {
        const r = await fetch('/api/session', { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const state = (await r.json()) as SessionState;
        if (cancelled) return;
        const remote = state.drafts[id]?.answers;
        if (remote && Object.keys(remote).length > 0) {
          setAnswers(remote);
          setSavedAt(state.drafts[id]?.updatedAt ?? null);
        } else {
          setAnswers(local);
        }
      } catch {
        if (!cancelled) setAnswers(local);
      } finally {
        if (!cancelled) setAnswersLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Mirror to localStorage as offline backup + debounced PUT to server.
  useEffect(() => {
    if (!id || !answersLoaded) return;
    try {
      localStorage.setItem(answersStorageKey(id), JSON.stringify(answers));
    } catch {
      // storage full / unavailable — ignore
    }

    const handle = setTimeout(async () => {
      setSaving(true);
      try {
        const r = await fetch(`/api/session/forms/${encodeURIComponent(id)}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        });
        if (r.ok) {
          const body = (await r.json()) as { updatedAt: number };
          setSavedAt(body.updatedAt);
        }
      } catch {
        // network error — local mirror still has the data
      } finally {
        setSaving(false);
      }
    }, 500);

    return () => clearTimeout(handle);
  }, [id, answers, answersLoaded]);

  // Tick once a second so the "saved Xs ago" label stays fresh.
  useEffect(() => {
    if (savedAt === null) return;
    const handle = setInterval(() => setSavedTick((t) => t + 1), 1000);
    return () => clearInterval(handle);
  }, [savedAt]);

  // Load PDF, compute per-page scaled metadata, and render each page into its canvas.
  useEffect(() => {
    if (!manifest || !containerRef.current) return;
    let cancelled = false;
    const container = containerRef.current;

    (async () => {
      const pdfjsLib = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

      const pdf = await pdfjsLib.getDocument(`/forms/pdfs/${manifest.id}.pdf`).promise;
      if (cancelled) {
        pdf.destroy();
        return;
      }

      const targetWidth = Math.min(container.clientWidth || TARGET_PAGE_WIDTH, TARGET_PAGE_WIDTH);
      const meta: PageMeta[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const baseVp = page.getViewport({ scale: 1 });
        const scale = targetWidth / baseVp.width;
        meta.push({ scale, width: baseVp.width * scale, height: baseVp.height * scale });
      }
      if (cancelled) {
        pdf.destroy();
        return;
      }
      setPages(meta);

      // Wait one paint so React mounts the canvases, then render into them.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) {
        pdf.destroy();
        return;
      }

      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) break;
        const canvas = canvasRefs.current.get(i);
        if (!canvas) continue;
        const page = await pdf.getPage(i);
        const { scale } = meta[i - 1];
        const vp = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        if (!cancelled) setRenderedPages(i);
      }

      pdf.destroy();
    })().catch((e) => {
      if (!cancelled) setError(String(e));
    });

    return () => {
      cancelled = true;
    };
  }, [manifest]);

  const fieldsByPage = useMemo(() => {
    const m = new Map<number, FormFieldDef[]>();
    if (!manifest) return m;
    for (const f of manifest.fields) {
      const arr = m.get(f.page) ?? [];
      arr.push(f);
      m.set(f.page, arr);
    }
    return m;
  }, [manifest]);

  const setAnswer = (name: string, value: string | boolean | null) => {
    setAnswers((prev) => ({ ...prev, [name]: value }));
  };

  const applyUpdates = useCallback((updates: Record<string, string | boolean | null>) => {
    setAnswers((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetForm = useCallback(() => {
    setAnswers({});
  }, []);

  const hasAnswers = Object.keys(answers).length > 0;

  const filledCount = useMemo(
    () =>
      Object.values(answers).filter((v) => v === true || (typeof v === 'string' && v.length > 0))
        .length,
    [answers],
  );

  if (error) {
    return <div className="h-full bg-neutral-950 text-red-400 p-8">{error}</div>;
  }
  if (!manifest) {
    return <div className="h-full bg-neutral-950 text-neutral-400 p-8">Loading…</div>;
  }

  return (
    <div className="h-full bg-neutral-900 text-neutral-100 flex flex-col lg:flex-row">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto">
        <div className="sticky top-0 z-10 bg-neutral-950/90 backdrop-blur border-b border-neutral-800 px-6 py-3 pl-16 lg:pl-6 flex items-center gap-4">
          <h1 className="text-lg font-semibold">{manifest.title}</h1>
          <div className="text-xs text-neutral-400 ml-auto flex items-center gap-3">
            <span>
              {pages.length > 0
                ? `${filledCount}/${manifest.fields.length} fields filled · page ${renderedPages}/${pages.length}`
                : `${filledCount}/${manifest.fields.length} fields filled · page ${renderedPages}/…`}
            </span>
            <span className="text-neutral-500" data-tick={savedTick}>
              {saving ? 'saving…' : (formatSavedAgo(savedAt, Date.now()) ?? '')}
            </span>
          </div>
        </div>

        <div ref={containerRef} className="p-6 flex flex-col items-center gap-6">
          {pages.map((meta, idx) => {
            const pageFields = fieldsByPage.get(idx) ?? [];
            return (
              <div
                key={idx}
                className="relative shadow-lg ring-1 ring-neutral-800 bg-white"
                style={{ width: `${meta.width}px`, height: `${meta.height}px` }}
              >
                <canvas
                  ref={(el) => {
                    if (el) canvasRefs.current.set(idx + 1, el);
                    else canvasRefs.current.delete(idx + 1);
                  }}
                  className="absolute inset-0"
                />
                <div className="absolute inset-0">
                  {pageFields.map((field, i) => (
                    <FieldInput
                      key={`${field.name}-${i}`}
                      field={field}
                      meta={meta}
                      value={answers[field.name]}
                      onChange={(v) => setAnswer(field.name, v)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {pages.length === 0 && (
            <div className="text-neutral-400 text-sm py-12">Loading PDF…</div>
          )}
        </div>
      </div>

      {id && (
        <ChatPanel
          formId={id}
          manifest={manifest}
          answers={answers}
          applyUpdates={applyUpdates}
          resetForm={resetForm}
          hasAnswers={hasAnswers}
        />
      )}
    </div>
  );
}
