import { vi } from 'vitest';

vi.mock('vscode', () => {
  class Uri {
    public fsPath: string;

    public constructor(fsPath: string) {
      this.fsPath = fsPath;
    }

    public static file(fsPath: string): Uri {
      return new Uri(fsPath);
    }

    public toString(): string {
      return this.fsPath;
    }
  }

  class Position {
    public constructor(
      public line: number,
      public character: number,
    ) {}
  }

  class Range {
    public constructor(
      public start: Position,
      public end: Position,
    ) {}
  }

  class RelativePattern {
    public constructor(
      public base: string | Uri,
      public pattern: string,
    ) {}
  }

  class MarkdownString {
    public constructor(public value: string) {}
  }

  class SnippetString {
    public constructor(public value: string) {}
  }

  class CompletionItem {
    public insertText: SnippetString | undefined;
    public documentation: MarkdownString | undefined;
    public detail: string | undefined;

    public constructor(
      public label: string,
      public kind?: number,
    ) {}
  }

  class Hover {
    public constructor(public contents: MarkdownString) {}
  }

  class Diagnostic {
    public constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }

  const workspace = {
    findFiles: vi.fn(async () => []),
    fs: {
      readFile: vi.fn(async () => new Uint8Array()),
    },
    getConfiguration: vi.fn(() => ({
      get: <T>(_key: string, defaultValue: T) => defaultValue,
    })),
  };

  return {
    Uri,
    RelativePattern,
    Position,
    Range,
    MarkdownString,
    SnippetString,
    CompletionItem,
    Hover,
    Diagnostic,
    CompletionItemKind: {
      Property: 9,
      Module: 10,
      Value: 11,
      EnumMember: 12,
    },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    workspace,
    window: {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose() {} })),
    },
    languages: {
      createDiagnosticCollection: vi.fn(() => ({
        set: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
        dispose() {},
      })),
      registerCompletionItemProvider: vi.fn(() => ({ dispose() {} })),
      registerHoverProvider: vi.fn(() => ({ dispose() {} })),
    },
  };
});
