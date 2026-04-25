import '@testing-library/jest-dom/vitest';
import '../../src/app/i18n';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 22+ ships an experimental `localStorage` global that lacks the standard
// API surface unless `--localstorage-file` is set, and vitest's jsdom env
// doesn't override it. Install a spec-compliant in-memory Storage so tests
// using localStorage / sessionStorage work portably.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
}

function installStorage(): void {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', { configurable: true, value: local });
    Object.defineProperty(target, 'sessionStorage', { configurable: true, value: session });
  }
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  cleanup();
});
