import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormManifest } from '../forms/types';
import { ChatPanel } from './ChatPanel';
import type { ChatMessage } from './useChatAgent';

interface MockHookState {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  sendMessage: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  loaded: boolean;
}

const hookState: MockHookState = {
  messages: [],
  streaming: false,
  error: null,
  sendMessage: vi.fn(),
  reset: vi.fn(),
  loaded: true,
};

interface MockVoice {
  settings: { input: boolean; output: boolean; camera: boolean };
}

const voiceState: MockVoice = {
  settings: { input: false, output: false, camera: false },
};

interface MockRecorder {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  recording: boolean;
  error: string | null;
}

const recorderState: MockRecorder = {
  start: vi.fn(),
  stop: vi.fn(),
  recording: false,
  error: null,
};

const transcribeMock = vi.fn();

vi.mock('./useChatAgent', async () => {
  const actual = await vi.importActual<typeof import('./useChatAgent')>('./useChatAgent');
  return {
    ...actual,
    useChatAgent: () => hookState,
  };
});

vi.mock('./voice', async () => {
  const actual = await vi.importActual<typeof import('./voice')>('./voice');
  return {
    ...actual,
    useVoiceSettings: () => ({
      settings: voiceState.settings,
      setInput: vi.fn(),
      setOutput: vi.fn(),
      setCamera: vi.fn(),
    }),
    useMicRecorder: () => recorderState,
    useTtsPlayer: () => ({ play: vi.fn(), stop: vi.fn(), playing: false }),
    transcribe: (...args: unknown[]) => transcribeMock(...args),
  };
});

const manifest: FormManifest = {
  id: 'acord-125',
  title: 'Test',
  fields: [],
};

beforeEach(() => {
  hookState.messages = [];
  hookState.streaming = false;
  hookState.error = null;
  hookState.sendMessage = vi.fn();
  hookState.reset = vi.fn();
  hookState.loaded = true;

  voiceState.settings = { input: false, output: false, camera: false };

  recorderState.start = vi.fn().mockResolvedValue(undefined);
  recorderState.stop = vi.fn().mockResolvedValue({
    blob: new Blob(['x'.repeat(2000)], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationMs: 1000,
  });
  recorderState.recording = false;
  recorderState.error = null;

  transcribeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPanel() {
  return render(
    <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
  );
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('ChatPanel push-to-talk', () => {
  it('does not register window listeners when voice input is disabled', () => {
    voiceState.settings = { input: false, output: false, camera: false };
    const spy = vi.spyOn(window, 'addEventListener');
    renderPanel();
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('keydown');
    expect(calls).not.toContain('keyup');
    expect(calls).not.toContain('blur');
    spy.mockRestore();
  });

  it('registers keydown/keyup/blur listeners when voice input is enabled', () => {
    voiceState.settings = { input: true, output: false, camera: false };
    const spy = vi.spyOn(window, 'addEventListener');
    renderPanel();
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls).toContain('keydown');
    expect(calls).toContain('keyup');
    expect(calls).toContain('blur');
    spy.mockRestore();
  });

  it('starts recording on Cmd+Space keydown', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    renderPanel();
    fireEvent.keyDown(window, { code: 'Space', metaKey: true });
    await flush();
    expect(recorderState.start).toHaveBeenCalledTimes(1);
  });

  it('also accepts Ctrl+Space as the PTT combo', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    renderPanel();
    fireEvent.keyDown(window, { code: 'Space', ctrlKey: true });
    await flush();
    expect(recorderState.start).toHaveBeenCalledTimes(1);
  });

  it('ignores key repeat events while held', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    renderPanel();
    fireEvent.keyDown(window, { code: 'Space', metaKey: true });
    fireEvent.keyDown(window, { code: 'Space', metaKey: true, repeat: true });
    fireEvent.keyDown(window, { code: 'Space', metaKey: true, repeat: true });
    await flush();
    expect(recorderState.start).toHaveBeenCalledTimes(1);
  });

  it('is a no-op while the agent is streaming', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    hookState.streaming = true;
    renderPanel();
    fireEvent.keyDown(window, { code: 'Space', metaKey: true });
    await flush();
    expect(recorderState.start).not.toHaveBeenCalled();
  });

  it('on keyup transcribes the recording and forwards the text via sendMessage', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    transcribeMock.mockResolvedValue('hello world');
    renderPanel();

    fireEvent.keyDown(window, { code: 'Space', metaKey: true });
    await flush();
    fireEvent.keyUp(window, { code: 'Space', key: 'Meta' });
    await flush();
    await flush();

    expect(recorderState.stop).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(hookState.sendMessage).toHaveBeenCalledWith('hello world');
  });

  it('does not call sendMessage when the recording is too short', async () => {
    voiceState.settings = { input: true, output: false, camera: false };
    recorderState.stop = vi.fn().mockResolvedValue({
      blob: new Blob(['x'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 50,
    });
    transcribeMock.mockResolvedValue('hi');
    renderPanel();

    fireEvent.keyDown(window, { code: 'Space', metaKey: true });
    await flush();
    fireEvent.keyUp(window, { code: 'Space', key: 'Meta' });
    await flush();
    await flush();

    expect(transcribeMock).not.toHaveBeenCalled();
    expect(hookState.sendMessage).not.toHaveBeenCalled();
  });
});
