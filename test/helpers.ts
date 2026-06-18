import * as vscode from 'vscode';

export function createTextDocument(
  text: string,
  fsPath = '/workspace/test.yaml',
) {
  const lines = text.split(/\r?\n/);
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  return {
    uri: vscode.Uri.file(fsPath),
    languageId: 'yaml',
    lineCount: lines.length,
    getText: () => text,
    lineAt(line: number) {
      return { text: lines[line] ?? '' };
    },
    offsetAt(position: { line: number; character: number }) {
      return (lineOffsets[position.line] ?? 0) + position.character;
    },
    positionAt(targetOffset: number) {
      for (let index = 0; index < lineOffsets.length; index += 1) {
        const start = lineOffsets[index] ?? 0;
        const end =
          index + 1 < lineOffsets.length
            ? (lineOffsets[index + 1] ?? text.length + 1) - 1
            : text.length;
        if (targetOffset >= start && targetOffset <= end) {
          return new vscode.Position(index, targetOffset - start);
        }
      }
      return new vscode.Position(
        lines.length - 1,
        lines[lines.length - 1]?.length ?? 0,
      );
    },
  };
}

export function positionOf(text: string, needle: string, fsPath?: string) {
  const document = createTextDocument(text, fsPath);
  const offset = text.indexOf(needle);
  if (offset === -1) {
    throw new Error(`Missing needle: ${needle}`);
  }
  return { document, position: document.positionAt(offset) };
}
