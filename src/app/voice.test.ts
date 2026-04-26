import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribe, useVoiceSettings } from './voice';

const VOICE_KEY = 'accordingly:voice';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useVoiceSettings', () => {
  it('starts at the all-false defaults when nothing is stored', () => {
    const { result } = renderHook(() => useVoiceSettings());
    expect(result.current.settings).toEqual({ input: false, output: false, camera: false });
  });

  it('reads previously stored settings on mount, including the new camera flag', () => {
    localStorage.setItem(
      VOICE_KEY,
      JSON.stringify({ input: true, output: true, camera: true }),
    );
    const { result } = renderHook(() => useVoiceSettings());
    expect(result.current.settings).toEqual({ input: true, output: true, camera: true });
  });

  it('migrates a legacy payload missing the camera key to camera=false', () => {
    localStorage.setItem(VOICE_KEY, JSON.stringify({ input: true, output: false }));
    const { result } = renderHook(() => useVoiceSettings());
    expect(result.current.settings).toEqual({ input: true, output: false, camera: false });
  });

  it('persists camera changes to localStorage and updates state', () => {
    const { result } = renderHook(() => useVoiceSettings());
    act(() => {
      result.current.setCamera(true);
    });
    expect(result.current.settings.camera).toBe(true);
    const stored = JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}');
    expect(stored).toEqual({ input: false, output: false, camera: true });
  });

  it('persists input and output changes independently', () => {
    const { result } = renderHook(() => useVoiceSettings());
    act(() => {
      result.current.setInput(true);
    });
    act(() => {
      result.current.setOutput(true);
    });
    expect(result.current.settings).toEqual({ input: true, output: true, camera: false });
    expect(JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}')).toEqual({
      input: true,
      output: true,
      camera: false,
    });
  });

  it('falls back to defaults when the stored payload is malformed JSON', () => {
    localStorage.setItem(VOICE_KEY, '{not-json');
    const { result } = renderHook(() => useVoiceSettings());
    expect(result.current.settings).toEqual({ input: false, output: false, camera: false });
  });
});

interface CapturedRequest {
  url: string;
  filename: string;
  blob: Blob;
}

function stubTranscribeFetch(
  response: () => Response | Promise<Response>,
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const body = init?.body as unknown;
      let filename = '';
      let blob: Blob = new Blob();
      if (body instanceof FormData) {
        const file: unknown = body.get('file');
        if (file instanceof File) {
          filename = file.name;
          blob = file;
        } else if (file instanceof Blob) {
          blob = file;
        }
      }
      calls.push({ url, filename, blob });
      return response();
    }),
  );
  return { calls };
}

describe('transcribe()', () => {
  it('uses the .webm extension for audio/webm', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: 'hi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await transcribe(new Blob(['x'], { type: 'audio/webm' }), 'audio/webm;codecs=opus');
    expect(out).toBe('hi');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/transcribe');
    expect(calls[0].filename).toBe('audio.webm');
  });

  it('uses the .m4a extension for audio/mp4', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await transcribe(new Blob(['x'], { type: 'audio/mp4' }), 'audio/mp4;codecs=mp4a.40.2');
    expect(calls[0].filename).toBe('audio.m4a');
  });

  it('uses the .ogg extension for audio/ogg', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await transcribe(new Blob(['x'], { type: 'audio/ogg' }), 'audio/ogg;codecs=opus');
    expect(calls[0].filename).toBe('audio.ogg');
  });

  it('uses the .wav extension for audio/wav', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await transcribe(new Blob(['x'], { type: 'audio/wav' }), 'audio/wav');
    expect(calls[0].filename).toBe('audio.wav');
  });

  it('falls back to .webm for an unrecognized mime type', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await transcribe(new Blob(['x'], { type: 'application/octet-stream' }), 'application/octet-stream');
    expect(calls[0].filename).toBe('audio.webm');
  });

  it('falls back to the blob.type when no explicit mimeType is passed', async () => {
    const { calls } = stubTranscribeFetch(() =>
      new Response(JSON.stringify({ text: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await transcribe(new Blob(['x'], { type: 'audio/ogg' }));
    expect(calls[0].filename).toBe('audio.ogg');
  });

  it('surfaces structured JSON error.message from the upstream response', async () => {
    stubTranscribeFetch(() =>
      new Response(
        JSON.stringify({ error: { code: 'upstream_error', message: 'whisper exploded' } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(transcribe(new Blob(['x'], { type: 'audio/webm' }))).rejects.toThrow(
      'whisper exploded',
    );
  });

  it('falls back to "transcription failed (status)" when the body is empty', async () => {
    stubTranscribeFetch(() => new Response('', { status: 503 }));
    await expect(transcribe(new Blob(['x'], { type: 'audio/webm' }))).rejects.toThrow(
      'transcription failed (503)',
    );
  });

  it('returns an empty string when upstream omits the text field', async () => {
    stubTranscribeFetch(() =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await transcribe(new Blob(['x'], { type: 'audio/webm' }))).toBe('');
  });
});
