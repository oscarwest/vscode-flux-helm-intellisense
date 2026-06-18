import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { isLintingEnabled } from '../src/extension';

describe('extension settings', () => {
  it('enables linting by default', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn((_key: string, defaultValue: boolean) => defaultValue),
    } as never);

    expect(isLintingEnabled()).toBe(true);
  });

  it('reads the linting enabled setting', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn(() => false),
    } as never);

    expect(isLintingEnabled()).toBe(false);
  });
});
