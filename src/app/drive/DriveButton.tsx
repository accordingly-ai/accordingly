import { useEffect, useRef, useState } from 'react';
import type { UseDriveResult } from './useDrive';

interface DriveButtonProps {
  drive: UseDriveResult;
}

export function DriveButton({ drive }: DriveButtonProps) {
  const { configured, connected, files, error, connect, disconnect, addFiles, removeFile } = drive;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!configured) {
    return (
      <span
        className="text-[11px] text-neutral-500"
        title="Set VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY, and VITE_GOOGLE_PICKER_APP_ID to enable Drive."
      >
        Drive: not configured
      </span>
    );
  }

  if (!connected) {
    return (
      <button
        type="button"
        title="Only the files you pick are visible to the app."
        onClick={async () => {
          setBusy(true);
          try {
            await connect();
            await addFiles();
          } catch {
            // error surfaced via drive.error
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="text-[11px] rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-2 py-0.5 disabled:opacity-60"
      >
        {busy ? 'Connecting…' : 'Connect Drive'}
      </button>
    );
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Only the files you pick are visible to the app."
        className="text-[11px] rounded border border-emerald-700/60 bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-200 px-2 py-0.5"
      >
        Drive · {files.length} file{files.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded border border-neutral-700 bg-neutral-900 shadow-lg p-2 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-neutral-300 font-medium">Connected files</span>
            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                try {
                  await addFiles();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="text-blue-400 hover:text-blue-300 disabled:opacity-60"
            >
              + Add files
            </button>
          </div>
          {files.length === 0 ? (
            <div className="text-neutral-500 italic mb-2">No files selected yet.</div>
          ) : (
            <ul className="space-y-1 max-h-56 overflow-y-auto mb-2">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-neutral-200" title={f.name}>
                    {f.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(f.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="text-red-400 mb-2">{error}</div>}
          <div className="flex justify-between border-t border-neutral-800 pt-2">
            <span className="text-neutral-500 leading-snug">
              Only files you pick are visible to the app.
            </span>
            <button
              type="button"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="text-neutral-400 hover:text-red-400 ml-2 shrink-0"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
