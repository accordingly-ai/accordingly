import { useCallback, useEffect, useRef, useState } from 'react';
import type { DriveFile } from './types';

const FILES_KEY = 'accordingly:drive:files';
const TOKEN_KEY = 'accordingly:drive:token';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const APP_ID = import.meta.env.VITE_GOOGLE_PICKER_APP_ID as string | undefined;

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
  callback?: (resp: TokenResponse) => void;
}

interface GoogleNS {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (resp: TokenResponse) => void;
        error_callback?: (err: unknown) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
  picker: {
    PickerBuilder: new () => PickerBuilder;
    ViewId: { DOCS: string; DOCS_IMAGES: string; PDFS: string };
    DocsView: new (viewId?: string) => DocsView;
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string; MIME_TYPE: string; LAST_EDITED_UTC: string };
  };
}

interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(cb: (data: PickerData) => void): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}

interface DocsView {
  setIncludeFolders(v: boolean): DocsView;
  setSelectFolderEnabled(v: boolean): DocsView;
  setMimeTypes(types: string): DocsView;
  setMode?(mode: string): DocsView;
}

interface PickerData {
  action: string;
  docs?: Array<{
    id: string;
    name: string;
    mimeType: string;
    lastEditedUtc?: number;
  }>;
}

interface GapiNS {
  load(name: string, cb: () => void): void;
}

declare global {
  interface Window {
    google?: GoogleNS;
    gapi?: GapiNS;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', () => {
      s.dataset.loaded = '1';
      resolve();
    });
    s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
    document.head.appendChild(s);
  });
}

const PICKER_BLOCKED_MESSAGE =
  "Couldn't open Google Picker — check that an ad-blocker (e.g. Brave Shields) isn't blocking apis.google.com.";

let pickerLoaded = false;
async function ensurePickerLoaded(): Promise<void> {
  try {
    await loadScript('https://apis.google.com/js/api.js');
  } catch {
    throw new Error(PICKER_BLOCKED_MESSAGE);
  }
  if (pickerLoaded) return;
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error(PICKER_BLOCKED_MESSAGE));
      return;
    }
    try {
      window.gapi.load('picker', () => {
        if (!window.google?.picker) {
          reject(new Error(PICKER_BLOCKED_MESSAGE));
          return;
        }
        pickerLoaded = true;
        resolve();
      });
    } catch {
      reject(new Error(PICKER_BLOCKED_MESSAGE));
    }
  });
}

async function ensureGisLoaded(): Promise<void> {
  await loadScript('https://accounts.google.com/gsi/client');
}

function loadFiles(): DriveFile[] {
  try {
    const raw = localStorage.getItem(FILES_KEY);
    return raw ? (JSON.parse(raw) as DriveFile[]) : [];
  } catch {
    return [];
  }
}

function saveFiles(files: DriveFile[]) {
  try {
    localStorage.setItem(FILES_KEY, JSON.stringify(files));
  } catch {
    // ignore
  }
}

function loadToken(): StoredToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    if (parsed.expiresAt > Date.now() + 30_000) return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveToken(t: StoredToken | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export interface UseDriveResult {
  configured: boolean;
  connected: boolean;
  files: DriveFile[];
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  addFiles: () => Promise<void>;
  removeFile: (id: string) => void;
  getToken: () => Promise<string>;
}

export function useDrive(): UseDriveResult {
  const [files, setFiles] = useState<DriveFile[]>(() => loadFiles());
  const [token, setToken] = useState<StoredToken | null>(() => loadToken());
  const [error, setError] = useState<string | null>(null);

  const tokenClientRef = useRef<TokenClient | null>(null);
  const tokenRef = useRef<StoredToken | null>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const configured = Boolean(CLIENT_ID && API_KEY && APP_ID);

  useEffect(() => {
    saveFiles(files);
  }, [files]);

  useEffect(() => {
    saveToken(token);
  }, [token]);

  const ensureTokenClient = useCallback(async (): Promise<TokenClient> => {
    if (tokenClientRef.current) return tokenClientRef.current;
    if (!configured) throw new Error('Google Drive is not configured');
    await ensureGisLoaded();
    const g = window.google;
    if (!g) throw new Error('Google Identity Services failed to load');
    const client = g.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID!,
      scope: SCOPE,
      callback: () => {
        // overridden per-request
      },
    });
    tokenClientRef.current = client;
    return client;
  }, [configured]);

  const requestToken = useCallback(
    async (prompt: '' | 'consent'): Promise<StoredToken> => {
      const client = await ensureTokenClient();
      return new Promise<StoredToken>((resolve, reject) => {
        client.callback = (resp) => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error || 'token request failed'));
            return;
          }
          const stored: StoredToken = {
            accessToken: resp.access_token,
            expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
          };
          setToken(stored);
          resolve(stored);
        };
        try {
          client.requestAccessToken({ prompt });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    [ensureTokenClient],
  );

  const connect = useCallback(async () => {
    setError(null);
    try {
      await requestToken('consent');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [requestToken]);

  const getToken = useCallback(async (): Promise<string> => {
    const cur = tokenRef.current;
    if (cur && cur.expiresAt > Date.now() + 30_000) return cur.accessToken;
    try {
      const fresh = await requestToken('');
      return fresh.accessToken;
    } catch (e) {
      setError('Drive session expired — please reconnect.');
      throw e;
    }
  }, [requestToken]);

  const addFiles = useCallback(async () => {
    setError(null);
    if (!configured) {
      setError('Google Drive is not configured');
      return;
    }
    try {
      const accessToken = await getToken();
      await ensurePickerLoaded();
      const g = window.google;
      if (!g?.picker) throw new Error('Picker failed to load');

      const docsView = new g.picker.DocsView()
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setMimeTypes(
          [
            'application/vnd.google-apps.document',
            'application/vnd.google-apps.spreadsheet',
            'application/pdf',
            'text/plain',
            'text/markdown',
            'text/csv',
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/heic',
          ].join(','),
        );

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          fn();
        };

        const picker = new g.picker.PickerBuilder()
          .addView(docsView)
          .setOAuthToken(accessToken)
          .setDeveloperKey(API_KEY!)
          .setAppId(APP_ID!)
          .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
          .setTitle('Select files for Accordingly')
          .setCallback((data) => {
            if (data.action === g.picker.Action.PICKED && data.docs) {
              const picked: DriveFile[] = data.docs.map((d) => ({
                id: d.id,
                name: d.name,
                mimeType: d.mimeType,
                modifiedTime: d.lastEditedUtc ? new Date(d.lastEditedUtc).toISOString() : undefined,
              }));
              setFiles((prev) => {
                const byId = new Map<string, DriveFile>();
                for (const f of prev) byId.set(f.id, f);
                for (const f of picked) byId.set(f.id, f);
                return [...byId.values()];
              });
              settle(resolve);
            } else if (data.action === g.picker.Action.CANCEL) {
              settle(resolve);
            }
          })
          .build();
        try {
          picker.setVisible(true);
        } catch {
          settle(() => reject(new Error(PICKER_BLOCKED_MESSAGE)));
          return;
        }

        timeoutId = setTimeout(() => {
          if (!document.querySelector('.picker-dialog')) {
            settle(() => reject(new Error(PICKER_BLOCKED_MESSAGE)));
          }
        }, 4000);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [configured, getToken]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const disconnect = useCallback(() => {
    const cur = tokenRef.current;
    if (cur && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(cur.accessToken);
      } catch {
        // ignore
      }
    }
    setToken(null);
    setFiles([]);
    setError(null);
  }, []);

  return {
    configured,
    connected: Boolean(token) || files.length > 0,
    files,
    error,
    connect,
    disconnect,
    addFiles,
    removeFile,
    getToken,
  };
}
