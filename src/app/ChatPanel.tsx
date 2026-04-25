import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApplicationAnswers, FormManifest } from '../forms/types';
import type { FieldValue } from '../forms/tools';
import { useChatAgent, type ChatMessage } from './useChatAgent';
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

export function ChatPanel({ formId, manifest, answers, applyUpdates }: ChatPanelProps) {
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
  const listRef = useRef<HTMLDivElement>(null);

  const { settings, setInput: setVoiceInput, setOutput: setVoiceOutput } = useVoiceSettings();
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

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || streaming) return;
    const text = input;
    setInput('');
    await sendMessage(text);
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

  const visible = messages.filter((m) => m.role !== 'tool' || true);
  const combinedError = error ?? recorder.error ?? voiceError;

  return (
    <aside
      className={
        'flex flex-col border-l border-neutral-800 bg-neutral-950 ' +
        'lg:w-[380px] lg:shrink-0 lg:h-screen lg:sticky lg:top-0 ' +
        (collapsed ? 'h-12 ' : 'h-[60vh] ') +
        'w-full'
      }
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 bg-neutral-900 relative">
        <span className="text-sm font-medium text-neutral-200">Assistant</span>
        <span className="text-[11px] text-neutral-500">{manifest.id}</span>
        <div className="ml-auto flex items-center gap-2">
          {tts.playing && (
            <button
              type="button"
              onClick={tts.stop}
              className="text-[11px] text-neutral-300 hover:text-white border border-neutral-700 rounded px-1.5 py-0.5"
              title="Stop playback"
            >
              ■ Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="text-neutral-400 hover:text-neutral-200 text-sm leading-none"
            aria-label="Voice settings"
            title="Voice settings"
          >
            ⚙
          </button>
          <DriveButton drive={drive} />
          {messages.length > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="lg:hidden text-[11px] text-neutral-400 hover:text-neutral-200"
          >
            {collapsed ? 'Open' : 'Hide'}
          </button>
        </div>
        {settingsOpen && (
          <div className="absolute right-2 top-full mt-1 z-10 w-56 rounded-md border border-neutral-700 bg-neutral-900 shadow-lg p-2 text-sm text-neutral-200">
            <label className="flex items-center gap-2 px-1 py-1 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.input}
                onChange={(e) => setVoiceInput(e.target.checked)}
              />
              <span>Voice input</span>
            </label>
            <label className="flex items-center gap-2 px-1 py-1 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.output}
                onChange={(e) => setVoiceOutput(e.target.checked)}
              />
              <span>Voice output</span>
            </label>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {visible.length === 0 && (
              <div className="text-xs text-neutral-500 leading-relaxed">
                Tell the agent about your business and it will start filling the form. Try:
                <div className="mt-2 italic text-neutral-400">
                  "My company is Acme Coffee LLC, founded 2018, in Brooklyn NY."
                </div>
              </div>
            )}
            {visible.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {streaming && (
              <div className="text-[11px] text-neutral-500 italic">assistant is typing…</div>
            )}
            {combinedError && (
              <div className="text-[12px] text-red-400 border border-red-900/60 bg-red-950/40 rounded p-2">
                {combinedError}
              </div>
            )}
          </div>

          <form
            onSubmit={onSubmit}
            className="border-t border-neutral-800 p-2 flex gap-2 bg-neutral-900 items-end"
          >
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
                title={recorder.recording ? 'Release to send' : 'Hold to talk'}
                aria-label="Hold to talk"
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
              placeholder={recorder.recording ? 'Listening…' : 'Tell me about your business…'}
              className="flex-1 resize-none rounded bg-neutral-800 text-neutral-100 placeholder:text-neutral-500 text-sm px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={streaming || recorder.recording}
            />
            <button
              type="submit"
              disabled={streaming || recorder.recording || !input.trim()}
              className="shrink-0 self-end rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm px-3 py-1.5"
            >
              Send
            </button>
          </form>
        </>
      )}
    </aside>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-blue-600 text-white text-sm px-3 py-2 whitespace-pre-wrap break-words">
          {message.content}
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
