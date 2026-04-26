import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApplicationAnswers, FormManifest } from '../forms/types';
import type { FieldValue } from '../forms/tools';
import { useChatAgent, type ChatAttachment, type ChatMessage } from './useChatAgent';
import { extractDocument, extractDroppedFile } from './drive/extractors';
import {
  transcribe,
  useMicRecorder,
  useTtsPlayer,
  useVoiceSettings,
} from './voice';
import { useDrive } from './drive/useDrive';
import { DriveButton } from './drive/DriveButton';

interface ChatPanelProps {
  formId: string;
  manifest: FormManifest;
  answers: ApplicationAnswers;
  applyUpdates: (updates: Record<string, FieldValue>) => void;
}

type PendingAttachment =
  | { id: string; name: string; mimeType: string; status: 'extracting' }
  | {
      id: string;
      name: string;
      mimeType: string;
      status: 'ready';
      text: string;
      truncated?: boolean;
    }
  | { id: string; name: string; mimeType: string; status: 'error'; error: string };

function nextAttachmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChatPanel({ formId, manifest, answers, applyUpdates }: ChatPanelProps) {
  const { t } = useTranslation();
  const drive = useDrive();
  const driveCtx = useMemo(
    () =>
      drive.connected && drive.files.length > 0
        ? { files: drive.files, getToken: drive.getToken }
        : undefined,
    [drive.connected, drive.files, drive.getToken],
  );
  const { messages, sendMessage, streaming, error, reset } = useChatAgent({
    formId,
    manifest,
    answers,
    applyUpdates,
    drive: driveCtx,
  });
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragDepth, setDragDepth] = useState(0);
  const [scanning, setScanning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const {
    settings,
    setInput: setVoiceInput,
    setOutput: setVoiceOutput,
    setCamera: setVoiceCamera,
  } = useVoiceSettings();
  const recorder = useMicRecorder();
  const tts = useTtsPlayer();

  const lastSpokenIndexRef = useRef<number>(-1);
  const messagesLenRef = useRef(messages.length);
  messagesLenRef.current = messages.length;

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Pin baseline to latest message on form change or when output is (re)enabled
  // so we don't replay loaded history or backlog.
  useEffect(() => {
    lastSpokenIndexRef.current = messagesLenRef.current - 1;
  }, [formId, settings.output]);

  useEffect(() => {
    if (!settings.output || streaming) return;
    let advanced = lastSpokenIndexRef.current;
    for (let i = lastSpokenIndexRef.current + 1; i < messages.length; i++) {
      advanced = i;
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      const content = (m.content ?? '').trim();
      if (!content) continue;
      void tts.play(content).catch((e) => {
        setVoiceError(e instanceof Error ? e.message : String(e));
      });
    }
    lastSpokenIndexRef.current = advanced;
  }, [messages, streaming, settings.output, tts]);

  const hasExtracting = pending.some((p) => p.status === 'extracting');
  const readyAttachments = pending.filter(
    (p): p is Extract<PendingAttachment, { status: 'ready' }> => p.status === 'ready',
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (streaming || hasExtracting) return;
    if (!input.trim() && readyAttachments.length === 0) return;
    const text = input;
    const attachments: ChatAttachment[] = readyAttachments.map((p) => ({
      name: p.name,
      mimeType: p.mimeType,
      text: p.text,
      ...(p.truncated ? { truncated: true } : {}),
    }));
    setInput('');
    setPending([]);
    if (attachments.length > 0) {
      await sendMessage(text, attachments);
    } else {
      await sendMessage(text);
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const entries: PendingAttachment[] = list.map((file) => ({
      id: nextAttachmentId(),
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      status: 'extracting' as const,
    }));
    setPending((prev) => [...prev, ...entries]);
    list.forEach((file, i) => {
      const id = entries[i].id;
      void extractDroppedFile(file).then(
        (result) => {
          setPending((prev) =>
            prev.map((p) =>
              p.id === id
                ? {
                    id,
                    name: result.name,
                    mimeType: result.mimeType,
                    status: 'ready',
                    text: result.text,
                    ...(result.truncated ? { truncated: true } : {}),
                  }
                : p,
            ),
          );
        },
        (err) => {
          setPending((prev) =>
            prev.map((p) =>
              p.id === id
                ? {
                    id,
                    name: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : p,
            ),
          );
        },
      );
    });
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragDepth(0);
    handleFiles(e.dataTransfer.files);
  };

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  const stopRecordingAndSend = async () => {
    const blob = await recorder.stop();
    if (!blob || blob.size === 0) return;
    try {
      const text = await transcribe(blob);
      if (text.trim()) {
        await sendMessage(text);
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRecording = async () => {
    setVoiceError(null);
    await recorder.start();
  };

  const onCameraFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setVoiceError(`Unsupported file type: ${file.type || 'unknown'}`);
      return;
    }
    setVoiceError(null);
    setScanning(true);
    try {
      const buf = await file.arrayBuffer();
      const { text } = await extractDocument(buf, file.type, file.name);
      const preamble = '[Scanned document]\n';
      setInput((prev) => `${prev ? `${prev}\n\n` : ''}${preamble}${text}\n\n`);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const visible = messages.filter((m) => m.role !== 'tool' || true);
  const combinedError = error ?? recorder.error ?? voiceError;

  return (
    <aside
      className={
        'relative flex flex-col border-l border-neutral-800 bg-neutral-950 ' +
        'lg:w-[380px] lg:shrink-0 lg:h-screen lg:sticky lg:top-0 ' +
        (collapsed ? 'h-12 ' : 'h-[60vh] ') +
        'w-full'
      }
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 bg-neutral-900 relative">
        <span className="text-sm font-medium text-neutral-200">{t('chat.title')}</span>
        <span className="text-[11px] text-neutral-500">{manifest.id}</span>
        <div className="ml-auto flex items-center gap-2">
          {tts.playing && (
            <button
              type="button"
              onClick={tts.stop}
              className="text-[11px] text-neutral-300 hover:text-white border border-neutral-700 rounded px-1.5 py-0.5"
              title={t('chat.stopPlayback')}
            >
              ■ {t('chat.stop')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setVoiceInput(!settings.input)}
            aria-pressed={settings.input}
            aria-label={t('chat.voiceInput')}
            title={t('chat.voiceInput')}
            className={
              'w-7 h-7 rounded flex items-center justify-center text-sm ' +
              (settings.input
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300')
            }
          >
            🎤
          </button>
          <button
            type="button"
            onClick={() => setVoiceOutput(!settings.output)}
            aria-pressed={settings.output}
            aria-label={t('chat.voiceOutput')}
            title={t('chat.voiceOutput')}
            className={
              'w-7 h-7 rounded flex items-center justify-center text-sm ' +
              (settings.output
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300')
            }
          >
            {settings.output ? '🔊' : '🔈'}
          </button>
          <button
            type="button"
            onClick={() => setVoiceCamera(!settings.camera)}
            aria-pressed={settings.camera}
            aria-label={t('chat.camera')}
            title={t('chat.camera')}
            className={
              'w-7 h-7 rounded flex items-center justify-center text-sm ' +
              (settings.camera
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300')
            }
          >
            📷
          </button>
          <DriveButton drive={drive} />
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label={t('chat.settings')}
            title={t('chat.settings')}
            className="w-7 h-7 rounded flex items-center justify-center text-sm text-neutral-400 hover:text-neutral-200"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="lg:hidden text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            {collapsed ? t('chat.open') : t('chat.hide')}
          </button>
        </div>
        {settingsOpen && (
          <div className="absolute right-2 top-full mt-1 z-10 w-48 rounded-md border border-neutral-700 bg-neutral-900 shadow-lg p-1 text-sm text-neutral-200">
            <button
              type="button"
              onClick={() => { reset(); setSettingsOpen(false); }}
              disabled={messages.length === 0}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {t('chat.reset')}
            </button>
          </div>
        )}
      </div>

      {!collapsed && dragDepth > 0 && (
        <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-400 rounded">
          <div className="text-sm text-blue-200 font-medium">
            {t('chat.dropToAttach')}
          </div>
        </div>
      )}

      {!collapsed && (
        <>
          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {visible.length === 0 && (
              <div className="text-xs text-neutral-500 leading-relaxed">
                {t('chat.welcome')}
              </div>
            )}
            {visible.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {streaming && (
              <div className="text-[11px] text-neutral-500 italic">{t('chat.typing')}</div>
            )}
            {combinedError && (
              <div className="text-[12px] text-red-400 border border-red-900/60 bg-red-950/40 rounded p-2">
                {combinedError}
              </div>
            )}
          </div>

          {pending.length > 0 && (
            <div className="border-t border-neutral-800 px-2 py-1.5 bg-neutral-900 flex flex-wrap gap-1.5">
              {pending.map((p) => (
                <PendingChip key={p.id} entry={p} onRemove={() => removePending(p.id)} />
              ))}
            </div>
          )}

          <form
            onSubmit={onSubmit}
            className="border-t border-neutral-800 p-2 flex gap-2 bg-neutral-900 items-end"
          >
            {settings.camera && (
              <>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onCameraFile}
                />
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={streaming || scanning}
                  className={
                    'shrink-0 self-end rounded text-white text-sm w-9 h-9 flex items-center justify-center ' +
                    (scanning
                      ? 'bg-neutral-600 animate-pulse'
                      : 'bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-500')
                  }
                  title={scanning ? t('chat.scanning') : t('chat.takePhoto')}
                  aria-label={t('chat.takePhoto')}
                >
                  {scanning ? '…' : '📷'}
                </button>
              </>
            )}
            {settings.input && (
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  void startRecording();
                }}
                onPointerUp={(e) => {
                  e.preventDefault();
                  void stopRecordingAndSend();
                }}
                onPointerLeave={() => {
                  if (recorder.recording) void stopRecordingAndSend();
                }}
                disabled={streaming}
                className={
                  'shrink-0 self-end rounded text-white text-sm w-9 h-9 flex items-center justify-center ' +
                  (recorder.recording
                    ? 'bg-red-600 animate-pulse'
                    : 'bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-500')
                }
                title={recorder.recording ? t('chat.releaseToSend') : t('chat.holdToTalk')}
                aria-label={t('chat.holdToTalk')}
              >
                {recorder.recording ? '●' : '🎤'}
              </button>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void onSubmit(e as unknown as React.FormEvent);
                }
              }}
              rows={2}
              placeholder={recorder.recording ? t('chat.listening') : t('chat.placeholder')}
              className="flex-1 resize-none rounded bg-neutral-800 text-neutral-100 placeholder:text-neutral-500 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={streaming || recorder.recording}
            />
            <button
              type="submit"
              disabled={
                streaming ||
                recorder.recording ||
                hasExtracting ||
                (!input.trim() && readyAttachments.length === 0)
              }
              className="shrink-0 self-end rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm px-3 py-1.5"
            >
              {t('chat.send')}
            </button>
          </form>
        </>
      )}
    </aside>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    const attachments = message.attachments ?? [];
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] flex flex-col items-end gap-1">
          {attachments.length > 0 && (
            <div className="flex flex-col items-end gap-1">
              {attachments.map((a, i) => (
                <div
                  key={i}
                  className="text-[11px] rounded bg-blue-700/60 text-blue-50 border border-blue-500/40 px-2 py-0.5"
                >
                  📎 {a.name}{' '}
                  <span className="text-blue-200/80">· {a.mimeType}</span>
                  {a.truncated && (
                    <span className="text-blue-200/80"> (truncated)</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {message.content && (
            <div className="rounded-lg bg-blue-600 text-white text-sm px-3 py-2 whitespace-pre-wrap break-words">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <ToolResultChip name={message.name ?? 'tool'} content={message.content} />
    );
  }

  // assistant
  const hasContent = message.content && message.content.length > 0;
  const calls = message.tool_calls ?? [];
  return (
    <div className="space-y-1">
      {hasContent && (
        <div className="max-w-[90%] rounded-lg bg-neutral-800 text-neutral-100 text-sm px-3 py-2 whitespace-pre-wrap break-words">
          {message.content}
        </div>
      )}
      {calls.map((c) => (
        <ToolCallChip key={c.id} name={c.name} args={c.arguments} />
      ))}
    </div>
  );
}

function ToolCallChip({ name, args }: { name: string; args: string }) {
  let summary = args;
  try {
    const parsed = JSON.parse(args || '{}') as Record<string, unknown>;
    if (name === 'set_fields' && Array.isArray(parsed.updates)) {
      summary = `${parsed.updates.length} field(s)`;
    } else if (name === 'get_fields' && Array.isArray(parsed.names)) {
      summary = (parsed.names as unknown[]).join(', ');
    } else if (name === 'list_unfilled_fields') {
      summary = '';
    }
  } catch {
    // keep raw
  }
  return (
    <div className="text-[11px] text-neutral-400 font-mono">
      → {name}
      {summary && <span className="text-neutral-500"> ({summary})</span>}
    </div>
  );
}

function PendingChip({
  entry,
  onRemove,
}: {
  entry: PendingAttachment;
  onRemove: () => void;
}) {
  let detail: React.ReactNode = null;
  let cls = 'border-neutral-700 bg-neutral-800 text-neutral-200';
  if (entry.status === 'extracting') {
    detail = <span className="text-neutral-400 italic">extracting…</span>;
  } else if (entry.status === 'ready') {
    cls = 'border-emerald-700/60 bg-emerald-900/30 text-emerald-100';
    detail = (
      <span className="text-emerald-200/80">
        {entry.text.length.toLocaleString()} chars
        {entry.truncated ? ' (truncated)' : ''}
      </span>
    );
  } else {
    cls = 'border-red-700/60 bg-red-900/30 text-red-100';
    detail = <span className="text-red-200/90">{entry.error}</span>;
  }
  return (
    <div
      className={`text-[11px] rounded border px-2 py-0.5 flex items-center gap-1.5 ${cls}`}
    >
      <span>📎 {entry.name}</span>
      <span className="opacity-60">·</span>
      {detail}
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 text-neutral-400 hover:text-white leading-none"
        aria-label="Remove attachment"
      >
        ×
      </button>
    </div>
  );
}

function ToolResultChip({ name, content }: { name: string; content: string }) {
  let summary = '';
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (name === 'set_fields') {
      const applied = Array.isArray(parsed.applied) ? parsed.applied.length : 0;
      const errors = Array.isArray(parsed.errors) ? parsed.errors.length : 0;
      summary = `applied ${applied}${errors ? `, ${errors} error(s)` : ''}`;
    } else if (name === 'list_unfilled_fields') {
      summary = `${parsed.count ?? '?'} unfilled`;
    } else if (name === 'get_fields') {
      const values = (parsed.values ?? {}) as Record<string, unknown>;
      summary = `${Object.keys(values).length} value(s)`;
    }
  } catch {
    summary = content.slice(0, 80);
  }
  return (
    <div className="text-[11px] text-neutral-500 font-mono pl-3 border-l border-neutral-800">
      ← {name} {summary}
    </div>
  );
}
