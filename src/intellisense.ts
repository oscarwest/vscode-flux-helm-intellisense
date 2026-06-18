import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { Document, Node, Pair } from 'yaml';
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import {
  describeNodeValue,
  findValuesContext,
  getMapEntries,
  getNodeAtPath,
  getYamlPathAtOffset,
} from './flux';
import type { ChartMetadata, JsonSchema, ValuesContext } from './types';

interface ValuesFallbackEntry {
  key: string;
  value: Node | undefined;
  description?: string;
}

function isVisibleChartKey(key: string): boolean {
  return !key.startsWith('_');
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) {
    return schema;
  }
  const ref = schema.$ref.replace(/^#\//, '');
  const parts = ref.split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (!isObjectLike(current)) {
      return schema;
    }
    current = current[part];
  }
  return isObjectLike(current) ? (current as JsonSchema) : schema;
}

function mergeSchemas(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const resolved = resolveRef(schema, root);
  const merged: JsonSchema = { ...resolved };
  for (const source of [
    ...asArray(resolved.allOf),
    ...asArray(resolved.anyOf),
    ...asArray(resolved.oneOf),
  ]) {
    const child = mergeSchemas(source, root);
    merged.properties = {
      ...(merged.properties ?? {}),
      ...(child.properties ?? {}),
    };
    if (merged.description === undefined) {
      merged.description = child.description;
    }
    if (merged.type === undefined) {
      merged.type = child.type;
    }
  }
  return merged;
}

function getSchemaAtPath(
  rootSchema: JsonSchema,
  path: string[],
): JsonSchema | undefined {
  let current = mergeSchemas(rootSchema, rootSchema);
  for (const segment of path) {
    current = mergeSchemas(current, rootSchema);
    const nextFromProperties = current.properties?.[segment];
    if (nextFromProperties) {
      current = nextFromProperties;
      continue;
    }
    if (
      current.additionalProperties &&
      typeof current.additionalProperties === 'object'
    ) {
      current = current.additionalProperties;
      continue;
    }
    if (Array.isArray(current.items)) {
      current = current.items[0];
      continue;
    }
    if (current.items && typeof current.items === 'object') {
      current = current.items;
      continue;
    }
    return undefined;
  }
  return mergeSchemas(current, rootSchema);
}

function completionKindForSchema(
  schema: JsonSchema,
): vscode.CompletionItemKind {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object':
      return vscode.CompletionItemKind.Module;
    case 'array':
      return vscode.CompletionItemKind.Value;
    case 'boolean':
      return vscode.CompletionItemKind.EnumMember;
    case 'number':
    case 'integer':
      return vscode.CompletionItemKind.Value;
    default:
      return vscode.CompletionItemKind.Property;
  }
}

export function buildSchemaCompletionItems(
  properties: Record<string, JsonSchema>,
  existingKeys: Set<string>,
): vscode.CompletionItem[] {
  return Object.entries(properties)
    .filter(([key]) => isVisibleChartKey(key) && !existingKeys.has(key))
    .map(([key, propertySchema]) => {
      const item = new vscode.CompletionItem(
        key,
        completionKindForSchema(propertySchema),
      );
      item.insertText = new vscode.SnippetString(
        `${key}: ${yamlSnippetForSchema(propertySchema)}`,
      );
      item.documentation = documentationForSchema(propertySchema);
      item.detail = propertySchema.title ?? 'Chart value';
      return item;
    });
}

function yamlSnippetForSchema(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') {
    return '\n  ${1}';
  }
  if (type === 'array') {
    return `\n  - \${1}`;
  }
  return snippetScalarValue(schema.default ?? schema.examples?.[0] ?? '');
}

function yamlSnippetForValue(value: unknown): string {
  if (Array.isArray(value)) {
    return '\n  - ${1}';
  }
  if (isObjectLike(value)) {
    return '\n  ${1}';
  }
  return snippetScalarValue(value);
}

function snippetScalarValue(value: unknown): string {
  if (typeof value === 'string') {
    return value === '' ? '${1}' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '${1}';
}

function documentationForSchema(
  schema: JsonSchema,
): vscode.MarkdownString | undefined {
  const parts = [
    schema.description,
    formatValueSection('Default', schema.default),
    schema.enum
      ? `Allowed: ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`
      : undefined,
  ].filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return new vscode.MarkdownString(parts.join('\n\n'));
}

function formatValueSection(label: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return `${label}: ${JSON.stringify(value)}`;
  }

  const rendered = stringify(value).trimEnd();
  const lines = rendered.split('\n').slice(0, 12);
  const truncated = lines.join('\n');
  const suffix = rendered.split('\n').length > 12 ? '\n...' : '';
  return `${label}:\n\n\`\`\`yaml\n${truncated}${suffix}\n\`\`\``;
}

function formatDescription(
  description: string | undefined,
): string | undefined {
  if (!description) {
    return undefined;
  }
  const lines = description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n\n') : undefined;
}

function getPairDescription(item: Pair<unknown, unknown>): string | undefined {
  const comment = formatDescription(
    (item.value as { commentBefore?: string; comment?: string } | undefined)
      ?.commentBefore ??
      (item.key as { commentBefore?: string; comment?: string } | undefined)
        ?.commentBefore ??
      (item as { commentBefore?: string; comment?: string }).commentBefore ??
      (item.value as { commentBefore?: string; comment?: string } | undefined)
        ?.comment ??
      (item.key as { commentBefore?: string; comment?: string } | undefined)
        ?.comment ??
      (item as { commentBefore?: string; comment?: string }).comment,
  );
  return comment;
}

function getValuesFallbackEntries(
  node: Node | undefined,
): ValuesFallbackEntry[] {
  if (!isMap(node)) {
    return [];
  }

  return node.items.flatMap((item: Pair<unknown, unknown>) => {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') {
      return [];
    }
    if (!isVisibleChartKey(item.key.value)) {
      return [];
    }
    return [
      {
        key: item.key.value,
        value: item.value as Node | undefined,
        description: getPairDescription(item),
      } satisfies ValuesFallbackEntry,
    ];
  });
}

function buildDocumentation(
  description: string | undefined,
  valueLabel: string,
  value: unknown,
): vscode.MarkdownString | undefined {
  const sections = [description, formatValueSection(valueLabel, value)].filter(
    Boolean,
  );
  if (sections.length === 0) {
    return undefined;
  }
  return new vscode.MarkdownString(sections.join('\n\n'));
}

function getFallbackEntryAtPath(
  root: Node | undefined,
  path: string[],
): ValuesFallbackEntry | undefined {
  if (path.length === 0) {
    return undefined;
  }

  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (isMap(current)) {
      const entry = getValuesFallbackEntries(current).find(
        (candidate) => candidate.key === segment,
      );
      if (!entry) {
        return undefined;
      }
      if (index === path.length - 1) {
        return entry;
      }
      current = entry.value;
      continue;
    }
    if (isSeq(current)) {
      const itemIndex = Number.parseInt(segment, 10);
      if (Number.isNaN(itemIndex)) {
        return undefined;
      }
      current = current.items[itemIndex] as Node | undefined;
      continue;
    }
    return undefined;
  }

  return undefined;
}

async function readSchema(
  metadata: ChartMetadata,
): Promise<JsonSchema | undefined> {
  if (!metadata.valuesSchemaPath) {
    return undefined;
  }
  const raw = await fs.readFile(metadata.valuesSchemaPath, 'utf8');
  return JSON.parse(raw) as JsonSchema;
}

async function readValuesDocument(
  metadata: ChartMetadata,
): Promise<Document.Parsed<any> | undefined> {
  if (!metadata.valuesPath) {
    return undefined;
  }
  const raw = await fs.readFile(metadata.valuesPath, 'utf8');
  return parseDocument(raw, {
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  }) as Document.Parsed<any>;
}

function getCurrentPath(
  document: vscode.TextDocument,
  position: vscode.Position,
  mode: 'completion' | 'hover' = 'hover',
): { path: string[]; valuesRoot: Node | undefined } | undefined {
  const context = findValuesContext(document, position);
  if (!context) {
    return undefined;
  }
  const offset = document.offsetAt(position);
  const path = getYamlPathAtOffset(context.valuesNode, offset).filter(
    (segment) => segment !== 'items',
  );
  if (mode === 'completion') {
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.slice(0, position.character);
    const trimmed = linePrefix.trim();
    if (trimmed.length === 0) {
      return {
        path: getCompletionPathForBlankLine(
          document,
          position,
          context.valuesNode,
          context.valuesKeyOffset,
        ),
        valuesRoot: context.valuesNode,
      };
    }
    if (trimmed.length > 0 && !trimmed.includes(':') && path.length > 0) {
      path.pop();
    }
  }
  return { path, valuesRoot: context.valuesNode };
}

function indentationOfLine(lineText: string): number {
  let indentation = 0;
  while (indentation < lineText.length && lineText[indentation] === ' ') {
    indentation += 1;
  }
  return indentation;
}

function getCompletionPathForBlankLine(
  document: vscode.TextDocument,
  position: vscode.Position,
  valuesRoot: Node | undefined,
  valuesKeyOffset: number,
): string[] {
  if (!valuesRoot?.range) {
    return [];
  }

  const currentIndent = indentationOfLine(document.lineAt(position.line).text);
  const valuesStartLine = document.positionAt(valuesKeyOffset).line;

  for (let line = position.line - 1; line > valuesStartLine; line -= 1) {
    const text = document.lineAt(line).text;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = indentationOfLine(text);
    const previousPath = getYamlPathAtOffset(
      valuesRoot,
      document.offsetAt(new vscode.Position(line, text.length)),
    ).filter((segment) => segment !== 'items');

    if (trimmed.endsWith(':')) {
      if (currentIndent > indent) {
        return previousPath;
      }
      return previousPath.slice(0, -1);
    }

    if (currentIndent <= indent) {
      return previousPath.slice(0, -1);
    }

    return previousPath;
  }

  return [];
}

export async function provideSchemaCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  metadata: ChartMetadata,
): Promise<vscode.CompletionItem[]> {
  const schema = await readSchema(metadata);
  const location = getCurrentPath(document, position, 'completion');
  const context = findValuesContext(document, position);
  if (!schema || (!location && !context)) {
    return [];
  }

  const path = (location?.path ?? []).filter(
    (segment) => !/^\d+$/.test(segment),
  );
  const parentSchema = getSchemaAtPath(schema, path);
  const existingNode = getNodeAtPath(
    (location?.valuesRoot ?? context?.valuesNode) as Node | undefined,
    path,
  );
  const existingKeys = new Set(
    getMapEntries(existingNode).map((entry) => entry.key),
  );
  return buildSchemaCompletionItems(
    parentSchema?.properties ?? {},
    existingKeys,
  );
}

export async function provideSchemaHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  metadata: ChartMetadata,
): Promise<vscode.Hover | undefined> {
  const schema = await readSchema(metadata);
  const location = getCurrentPath(document, position);
  if (!schema || !location) {
    return undefined;
  }
  const path = location.path.filter((segment) => !/^\d+$/.test(segment));
  const currentSchema = getSchemaAtPath(schema, path);
  const docs = currentSchema
    ? documentationForSchema(currentSchema)
    : undefined;
  return docs ? new vscode.Hover(docs) : undefined;
}

export async function provideSchemaDiagnostics(
  document: vscode.TextDocument,
  metadata: ChartMetadata,
  context: ValuesContext,
): Promise<vscode.Diagnostic[]> {
  const schema = await readSchema(metadata);
  if (!schema) {
    return [];
  }

  const diagnostics: vscode.Diagnostic[] = [];
  const text = document.getText();

  const visitNode = (node: Node | undefined, path: string[]): void => {
    const currentSchema = getSchemaAtPath(
      schema,
      path.filter((segment) => !/^\d+$/.test(segment)),
    );
    if (!node || !currentSchema) {
      return;
    }
    if (isMap(node)) {
      for (const entry of getMapEntries(node)) {
        if (
          !currentSchema.properties?.[entry.key] &&
          currentSchema.additionalProperties === false
        ) {
          const keyText = `${entry.key}:`;
          const offset = text.indexOf(
            keyText,
            context.valuesNode?.range?.[0] ?? 0,
          );
          if (offset !== -1) {
            const start = document.positionAt(offset);
            const end = document.positionAt(offset + entry.key.length);
            diagnostics.push(
              new vscode.Diagnostic(
                new vscode.Range(start, end),
                `Unknown chart value key '${entry.key}'.`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
        visitNode(entry.value, [...path, entry.key]);
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        visitNode(item as Node | undefined, [...path, String(index)]);
      });
    }
  };

  visitNode(context.valuesNode, []);
  return diagnostics;
}

export async function provideValuesFallbackCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  metadata: ChartMetadata,
): Promise<vscode.CompletionItem[]> {
  const valuesDoc = await readValuesDocument(metadata);
  const location = getCurrentPath(document, position, 'completion');
  const context = findValuesContext(document, position);
  if (!valuesDoc || (!location && !context)) {
    return [];
  }

  const path = (location?.path ?? []).filter(
    (segment) => !/^\d+$/.test(segment),
  );
  const node = getNodeAtPath(valuesDoc.contents as Node | undefined, path);
  const existingNode = getNodeAtPath(
    (location?.valuesRoot ?? context?.valuesNode) as Node | undefined,
    path,
  );
  const existingKeys = new Set(
    getMapEntries(existingNode).map((entry) => entry.key),
  );

  return buildValuesFallbackCompletionItems(node, existingKeys);
}

export function buildValuesFallbackCompletionItems(
  node: Node | undefined,
  existingKeys: Set<string>,
): vscode.CompletionItem[] {
  return getValuesFallbackEntries(node)
    .filter((entry) => !existingKeys.has(entry.key))
    .map((entry) => {
      const item = new vscode.CompletionItem(
        entry.key,
        vscode.CompletionItemKind.Property,
      );
      const value = describeNodeValue(entry.value);
      item.insertText = new vscode.SnippetString(
        `${entry.key}: ${yamlSnippetForValue(value)}`,
      );
      item.documentation = buildDocumentation(
        entry.description,
        'Example',
        value,
      );
      return item;
    });
}

export async function provideValuesFallbackHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  metadata: ChartMetadata,
): Promise<vscode.Hover | undefined> {
  const valuesDoc = await readValuesDocument(metadata);
  const location = getCurrentPath(document, position);
  if (!valuesDoc || !location) {
    return undefined;
  }
  const path = location.path.filter((segment) => !/^\d+$/.test(segment));
  const entry = getFallbackEntryAtPath(
    valuesDoc.contents as Node | undefined,
    path,
  );
  const value = describeNodeValue(entry?.value);
  if (value === undefined && !entry?.description) {
    return undefined;
  }
  const documentation = buildDocumentation(
    entry?.description,
    'Example',
    value,
  );
  return documentation ? new vscode.Hover(documentation) : undefined;
}
