import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

vi.mock('./useChatAgent', async () => {
  const actual = await vi.importActual<typeof import('./useChatAgent')>('./useChatAgent');
  return {
    ...actual,
    useChatAgent: () => hookState,
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChatPanel', () => {
  it('renders the empty-state hint when no messages are present', () => {
    render(
      <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
    );
    expect(
      screen.getByText(/Hi! I'll help you fill out this application for your client/),
    ).toBeInTheDocument();
  });

  it('sends a typed message and clears the input on submit', async () => {
    const user = userEvent.setup();
    render(
      <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
    );
    const textarea = screen.getByPlaceholderText('Tell me about your client…') as HTMLTextAreaElement;
    await user.type(textarea, 'I run a coffee shop');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(hookState.sendMessage).toHaveBeenCalledWith('I run a coffee shop');
    expect(textarea.value).toBe('');
  });

  it('disables Send while streaming', () => {
    hookState.streaming = true;
    render(
      <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('assistant is typing…')).toBeInTheDocument();
  });

  it('renders user and assistant messages from the hook', () => {
    hookState.messages = [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi back!' },
    ];
    render(
      <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
    );
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText('hi back!')).toBeInTheDocument();
  });

  it('shows error banner and lets the user reset via the settings popover', async () => {
    const user = userEvent.setup();
    hookState.messages = [{ role: 'user', content: 'go' }];
    hookState.error = 'OpenAI exploded';
    render(
      <ChatPanel formId="acord-125" manifest={manifest} answers={{}} applyUpdates={() => {}} />,
    );
    expect(screen.getByText('OpenAI exploded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Reset conversation' }));
    expect(hookState.reset).toHaveBeenCalledTimes(1);
  });
});
