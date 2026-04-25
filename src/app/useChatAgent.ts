import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApplicationAnswers, FormManifest } from '../forms/types';
import { executeTool, type FieldValue, type ToolExecutionResult } from '../forms/tools';
import type { DriveFile } from './drive/types';
import { extractFile } from './drive/extractors';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  text: string;
  truncated?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** user only */
  attachments?: ChatAttachment[];
  /** assistant only */
  tool_calls?: ToolCall[];
  /** tool only */
  tool_call_id?: string;
  name?: string;
}

const MAX_TOOL_ROUNDS = 6;

function chatStorageKey(formId: string) {
  return `accordingly:chat:${formId}`;
}

function loadMessages(formId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(chatStorageKey(formId));
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

interface OpenAIDelta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface OpenAIStreamChunk {
  choices?: { delta?: OpenAIDelta; finish_reason?: string | null }[];
}

export interface AssistantAccumulator {
  content: string;
  toolCalls: Map<number, ToolCall>;
}

export function applyDelta(acc: AssistantAccumulator, delta: OpenAIDelta) {
  if (delta.content) acc.content += delta.content;
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const existing = acc.toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      acc.toolCalls.set(tc.index, existing);
    }
  }
}

export function accumulatorToMessage(acc: AssistantAccumulator): ChatMessage {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);
  return {
    role: 'assistant',
    content: acc.content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function toApiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: m.content || '' };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return out;
  }
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      content: m.content,
    };
  }
  if (m.role === 'user' && m.attachments?.length) {
    const parts: string[] = [];
    if (m.content) parts.push(m.content);
    for (const att of m.attachments) {
      const header = `[Attachment: ${att.name} (${att.mimeType}${
        att.truncated ? ', truncated' : ''
      })]`;
      parts.push(`${header}\n${att.text}\n[/Attachment]`);
    }
    return { role: 'user', content: parts.join('\n\n') };
  }
  return { role: m.role, content: m.content };
}

export interface DriveAgentContext {
  files: DriveFile[];
  getToken: () => Promise<string>;
}

export interface UseChatAgentOptions {
  formId: string;
  manifest: FormManifest;
  answers: ApplicationAnswers;
  applyUpdates: (updates: Record<string, FieldValue>) => void;
  drive?: DriveAgentContext;
}

const DRIVE_TOOL_NAMES = new Set(['list_drive_files', 'read_drive_file']);

async function executeDriveTool(
  name: string,
  args: Record<string, unknown>,
  drive: DriveAgentContext,
): Promise<ToolExecutionResult> {
  if (name === 'list_drive_files') {
    return {
      result: {
        files: drive.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
      },
    };
  }
  if (name === 'read_drive_file') {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) return { result: { error: 'missing id' } };
    const file = drive.files.find((f) => f.id === id);
    if (!file) return { result: { error: `file not connected: ${id}` } };
    try {
      const token = await drive.getToken();
      const { text, truncated } = await extractFile(file, token);
      return {
        result: {
          name: file.name,
          mimeType: file.mimeType,
          text,
          ...(truncated ? { truncated: true } : {}),
        },
      };
    } catch (e) {
      return {
        result: {
          name: file.name,
          mimeType: file.mimeType,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }
  return { result: { error: `unknown drive tool: ${name}` } };
}

export function useChatAgent({
  formId,
  manifest,
  answers,
  applyUpdates,
  drive,
}: UseChatAgentOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always-current refs for use inside the async streaming loop.
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const driveRef = useRef<DriveAgentContext | undefined>(drive);
  useEffect(() => {
    driveRef.current = drive;
  }, [drive]);

  // Load persisted history on form change.
  useEffect(() => {
    setMessages(loadMessages(formId));
    setLoaded(true);
  }, [formId]);

  // Persist on change (after initial load).
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(chatStorageKey(formId), JSON.stringify(messages));
    } catch {
      // ignore quota errors
    }
  }, [formId, messages, loaded]);

  const runRound = useCallback(
    async (history: ChatMessage[]): Promise<ChatMessage> => {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          formId,
          messages: history.map(toApiMessage),
          driveConnected: !!driveRef.current,
        }),
      });
      if (!res.ok || !res.body) {
        let detail = '';
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          detail = j.error?.message ?? '';
        } catch {
          detail = await res.text().catch(() => '');
        }
        throw new Error(detail || `chat request failed (${res.status})`);
      }

      const acc: AssistantAccumulator = { content: '', toolCalls: new Map() };
      // Add a placeholder assistant message that we mutate as deltas arrive.
      const placeholderIndex = history.length;
      setMessages([...history, { role: 'assistant', content: '' }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenAIStreamChunk;
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            applyDelta(acc, delta);
            const snapshot = accumulatorToMessage(acc);
            setMessages((prev) => {
              const next = prev.slice();
              next[placeholderIndex] = snapshot;
              return next;
            });
          }
        }
      }

      return accumulatorToMessage(acc);
    },
    [formId],
  );

  const sendMessage = useCallback(
    async (text: string, attachments?: ChatAttachment[]) => {
      const trimmed = text.trim();
      if (streaming) return;
      if (!trimmed && !(attachments && attachments.length > 0)) return;
      setError(null);

      const userMessage: ChatMessage = {
        role: 'user',
        content: trimmed,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const baseHistory: ChatMessage[] = [...messages, userMessage];
      setMessages(baseHistory);
      setStreaming(true);

      try {
        let history = baseHistory;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const assistantMsg = await runRound(history);
          history = [...history, assistantMsg];

          const calls = assistantMsg.tool_calls;
          if (!calls || calls.length === 0) {
            setMessages(history);
            return;
          }

          const toolMessages: ChatMessage[] = [];
          const aggregateUpdates: Record<string, FieldValue> = {};
          for (const call of calls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
            } catch {
              parsedArgs = {};
            }
            let execResult: ToolExecutionResult;
            if (DRIVE_TOOL_NAMES.has(call.name)) {
              const ctx = driveRef.current;
              if (!ctx) {
                execResult = { result: { error: 'drive not connected' } };
              } else {
                execResult = await executeDriveTool(call.name, parsedArgs, ctx);
              }
            } else {
              execResult = executeTool(
                call.name,
                parsedArgs,
                manifest,
                answersRef.current,
              );
            }
            const { result, updates } = execResult;
            if (updates) {
              for (const [k, v] of Object.entries(updates)) {
                aggregateUpdates[k] = v;
                // Reflect in the live snapshot so subsequent calls in the same
                // round see the just-applied values.
                answersRef.current = { ...answersRef.current, [k]: v };
              }
            }
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify(result),
            });
          }

          if (Object.keys(aggregateUpdates).length > 0) {
            applyUpdates(aggregateUpdates);
          }

          history = [...history, ...toolMessages];
          setMessages(history);
        }
        // Hit the cap.
        setError('Stopped after maximum tool-call rounds.');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStreaming(false);
      }
    },
    [messages, streaming, manifest, applyUpdates, runRound],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return { messages, sendMessage, streaming, error, reset, loaded };
}
