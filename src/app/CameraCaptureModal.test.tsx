import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraCaptureModal } from './CameraCaptureModal';

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}

interface FakeStream {
  getTracks: () => FakeTrack[];
}

function makeStream(): { stream: FakeStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream: FakeStream = { getTracks: () => tracks };
  return { stream, tracks };
}

interface FakeNav {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
}

function installMediaDevices(nav: FakeNav): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: nav,
  });
}

beforeEach(() => {
  // Default toBlob stub returns a small jpeg blob.
  HTMLCanvasElement.prototype.toBlob = function (callback) {
    callback(new Blob(['x'], { type: 'image/jpeg' }));
  } as typeof HTMLCanvasElement.prototype.toBlob;
  // jsdom returns null for canvas.getContext('2d'); stub a minimal 2D context.
  HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage: vi.fn() };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Force videoWidth/videoHeight so capture proceeds.
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get() {
      return 640;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get() {
      return 480;
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CameraCaptureModal', () => {
  it('acquires a stream on mount and stops every track on unmount', async () => {
    const { stream, tracks } = makeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    const onCapture = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<CameraCaptureModal onCapture={onCapture} onClose={onClose} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    unmount();
    for (const t of tracks) {
      expect(t.stop).toHaveBeenCalled();
    }
  });

  it('captures the current frame and emits a File via onCapture', async () => {
    const { stream } = makeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    const onCapture = vi.fn();
    render(<CameraCaptureModal onCapture={onCapture} onClose={() => {}} />);

    const captureBtn = await screen.findByRole('button', { name: 'Capture' });
    await waitFor(() => expect(captureBtn).not.toBeDisabled());
    await userEvent.setup().click(captureBtn);

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0][0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toMatch(/^photo-\d+\.jpg$/);
  });

  it('only renders the switch-camera button when more than one videoinput device is present', async () => {
    const { stream } = makeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'a' },
      { kind: 'videoinput', deviceId: 'b' },
      { kind: 'audioinput', deviceId: 'c' },
    ]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    render(<CameraCaptureModal onCapture={() => {}} onClose={() => {}} />);

    const switchBtn = await screen.findByRole('button', { name: 'Switch camera' });
    expect(switchBtn).toBeInTheDocument();
  });

  it('hides the switch button when only a single camera is available', async () => {
    const { stream } = makeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'a' },
    ]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    render(<CameraCaptureModal onCapture={() => {}} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Capture' });
    expect(screen.queryByRole('button', { name: 'Switch camera' })).toBeNull();
  });

  it('shows the file-picker fallback when getUserMedia rejects', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    render(<CameraCaptureModal onCapture={() => {}} onClose={() => {}} />);

    const fallbackBtn = await screen.findByRole('button', { name: 'Choose a file instead' });
    expect(fallbackBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
  });

  it('forwards the picked fallback file via onCapture', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    const onCapture = vi.fn();
    const { container } = render(
      <CameraCaptureModal onCapture={onCapture} onClose={() => {}} />,
    );
    await screen.findByRole('button', { name: 'Choose a file instead' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File(['data'], 'doc.png', { type: 'image/png' });
    await userEvent.setup().upload(input, file);
    expect(onCapture).toHaveBeenCalledWith(file);
  });

  it('closes when Escape is pressed', async () => {
    const { stream } = makeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    installMediaDevices({ getUserMedia, enumerateDevices });

    const onClose = vi.fn();
    render(<CameraCaptureModal onCapture={() => {}} onClose={onClose} />);
    await screen.findByRole('button', { name: 'Capture' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
