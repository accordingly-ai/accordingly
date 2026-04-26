import { useEffect, useRef, useState } from 'react';

interface CameraCaptureModalProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

type FacingMode = 'environment' | 'user';

export function CameraCaptureModal({ onCapture, onClose }: CameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<FacingMode>('environment');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      setReady(false);
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        }).catch(async (err) => {
          // Fallback: try without facingMode constraint
          if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
            return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          }
          throw err;
        });

        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setReady(true);

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            const videoInputs = devices.filter((d) => d.kind === 'videoinput');
            setHasMultipleCameras(videoInputs.length > 1);
          }
        } catch {
          // ignore
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Couldn't start the camera");
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
      }
    };
  }, [facingMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, {
          type: 'image/jpeg',
        });
        onCapture(file);
      },
      'image/jpeg',
      0.92,
    );
  };

  const handleSwitch = () => {
    setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'));
  };

  const handleFileFallback = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onCapture(file);
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onBackdropClick}
    >
      <div className="relative flex flex-col w-full max-w-2xl rounded-lg border border-neutral-700 bg-neutral-900 overflow-hidden">
        <div className="relative flex items-center justify-center bg-black aspect-video">
          {error ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <div className="text-sm text-red-300">Couldn't start the camera</div>
              <div className="text-[11px] text-neutral-400 break-words max-w-md">{error}</div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-2 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-100 text-sm px-3 py-1.5"
              >
                Choose a file instead
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleFileFallback}
              />
            </div>
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 p-3 bg-neutral-900 border-t border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm px-3 py-1.5"
          >
            Close
          </button>
          <div className="flex items-center gap-2">
            {hasMultipleCameras && !error && (
              <button
                type="button"
                onClick={handleSwitch}
                className="rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm px-3 py-1.5"
                title="Switch camera"
                aria-label="Switch camera"
              >
                ⇆
              </button>
            )}
            {!error && (
              <button
                type="button"
                onClick={handleCapture}
                disabled={!ready}
                className="rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm px-4 py-1.5"
              >
                Capture
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
