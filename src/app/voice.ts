import { useCallback, useEffect, useRef, useState } from 'react';

const VOICE_STORAGE_KEY = 'accordingly:voice';

export interface VoiceSettings {
  input: boolean;
  output: boolean;
}

const DEFAULT_SETTINGS: VoiceSettings = { input: false, output: false };

function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(VOICE_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      input: typeof parsed.input === 'boolean' ? parsed.input : false,
      output: typeof parsed.output === 'boolean' ? parsed.output : false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: VoiceSettings) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

export function useVoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const setInput = useCallback((value: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, input: value };
      persistSettings(next);
      return next;
    });
  }, []);

  const setOutput = useCallback((value: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, output: value };
      persistSettings(next);
      return next;
    });
  }, []);

  return { settings, setInput, setOutput };
}

interface MicRecorderState {
  recording: boolean;
  error: string | null;
}

export function useMicRecorder() {
  const [state, setState] = useState<MicRecorderState>({ recording: false, error: null });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopResolverRef = useRef<((blob: Blob) => void) | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setState({ recording: false, error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const type = mr.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        const resolver = stopResolverRef.current;
        stopResolverRef.current = null;
        setState({ recording: false, error: null });
        resolver?.(blob);
      };
      recorderRef.current = mr;
      mr.start();
      setState({ recording: true, error: null });
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      const message =
        e instanceof Error ? e.message : 'Microphone permission denied or unavailable';
      setState({ recording: false, error: message });
    }
  }, []);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const mr = recorderRef.current;
    if (!mr) return null;
    return new Promise<Blob>((resolve) => {
      stopResolverRef.current = resolve;
      try {
        mr.stop();
      } catch {
        stopResolverRef.current = null;
        resolve(new Blob([], { type: 'audio/webm' }));
      }
    });
  }, []);

  return { start, stop, recording: state.recording, error: state.error };
}

export async function transcribe(blob: Blob): Promise<string> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', blob, `audio.${ext}`);
  const res = await fetch('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j.error?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(detail || `transcription failed (${res.status})`);
  }
  const data = (await res.json()) as { text?: string };
  return data.text ?? '';
}

export function useTtsPlayer() {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const tokenRef = useRef(0);

  const cleanupUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    cleanupUrl();
    setPlaying(false);
  }, [cleanupUrl]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const play = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      stop();
      const token = ++tokenRef.current;
      try {
        const res = await fetch('/api/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const j = (await res.json()) as { error?: { message?: string } };
            detail = j.error?.message ?? '';
          } catch {
            detail = await res.text().catch(() => '');
          }
          throw new Error(detail || `tts failed (${res.status})`);
        }
        if (token !== tokenRef.current) return;
        const blob = await res.blob();
        if (token !== tokenRef.current) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audio.onended = () => {
            cleanupUrl();
            setPlaying(false);
          };
          audio.onerror = () => {
            cleanupUrl();
            setPlaying(false);
          };
          audioRef.current = audio;
        }
        audio.src = url;
        setPlaying(true);
        await audio.play();
      } catch (e) {
        if (token === tokenRef.current) {
          cleanupUrl();
          setPlaying(false);
        }
        throw e;
      }
    },
    [stop, cleanupUrl],
  );

  return { play, stop, playing };
}
