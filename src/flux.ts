import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Document, Node, Pair } from 'yaml';
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import type {
  HelmReleaseResource,
  HelmRepositoryResource,
  ParsedYamlDocument,
  ResolvedChart,
  ValuesContext,
} from './types';

interface IndexedYamlDocument extends ParsedYamlDocument {
  yamlDocument: Document.Parsed<any>;
}

interface RepositoryCacheEntry {
  repositories: HelmRepositoryResource[];
  loadedAt: number;
  cacheKey?: string;
}

const REPOSITORY_CACHE_TTL_MS = 60 * 1000;
let repositoryCache: RepositoryCacheEntry | undefined;
let repositoryCachePromise: Promise<HelmRepositoryResource[]> | undefined;
let configuredRepositoryCache: RepositoryCacheEntry | undefined;
let configuredRepositoryCachePromise:
  | Promise<HelmRepositoryResource[]>
  | undefined;
const YAML_FILE_PATTERN = '**/*.{yaml,yml}';
const YAML_EXCLUDE_PATTERN = '**/{node_modules,.git,out,dist}/**';

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNamespace(metadata: unknown): string | undefined {
  if (!isObjectLike(metadata)) {
    return undefined;
  }
  return getString(metadata.namespace);
}

function getName(metadata: unknown): string | undefined {
  if (!isObjectLike(metadata)) {
    return undefined;
  }
  return getString(metadata.name);
}

function extractStartOffsets(text: string): number[] {
  const starts = [0];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerIndex = text.indexOf('\n---', searchFrom);
    if (markerIndex === -1) {
      break;
    }
    starts.push(markerIndex + 1);
    searchFrom = markerIndex + 4;
  }
  return starts;
}

export function parseYamlDocuments(
  text: string,
  uri: vscode.Uri,
): IndexedYamlDocument[] {
  const lineCounter = new LineCounter();
  const parsed = parseAllDocuments(text, {
    lineCounter,
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  });
  const starts = extractStartOffsets(text);
  return parsed.map((yamlDocument, index) => ({
    uri,
    index,
    text,
    root: yamlDocument.toJSON(),
    startOffset: starts[index] ?? 0,
    endOffset: starts[index + 1] ?? text.length,
    yamlDocument,
  }));
}

function isHelmReleaseObject(root: unknown): root is Record<string, unknown> {
  if (!isObjectLike(root)) {
    return false;
  }
  const apiVersion = getString(root.apiVersion);
  const kind = getString(root.kind);
  return (
    kind === 'HelmRelease' &&
    typeof apiVersion === 'string' &&
    apiVersion.startsWith('helm.toolkit.fluxcd.io/')
  );
}

function isHelmRepositoryObject(
  root: unknown,
): root is Record<string, unknown> {
  if (!isObjectLike(root)) {
    return false;
  }
  const apiVersion = getString(root.apiVersion);
  const kind = getString(root.kind);
  return (
    kind === 'HelmRepository' &&
    typeof apiVersion === 'string' &&
    apiVersion.startsWith('source.toolkit.fluxcd.io/')
  );
}

export function getHelmReleases(
  documents: ParsedYamlDocument[],
): HelmReleaseResource[] {
  return documents.flatMap((document) => {
    if (!isHelmReleaseObject(document.root)) {
      return [];
    }
    const metadata = isObjectLike(document.root.metadata)
      ? document.root.metadata
      : {};
    const spec = isObjectLike(document.root.spec) ? document.root.spec : {};
    return [
      {
        apiVersion: getString(document.root.apiVersion),
        kind: 'HelmRelease',
        metadata: {
          name: getName(metadata) ?? '',
          namespace: getNamespace(metadata),
        },
        spec: spec as HelmReleaseResource['spec'],
        documentUri: document.uri,
      } satisfies HelmReleaseResource,
    ];
  });
}

export function getHelmRepositories(
  documents: ParsedYamlDocument[],
): HelmRepositoryResource[] {
  return documents.flatMap((document) => {
    if (!isHelmRepositoryObject(document.root)) {
      return [];
    }
    const metadata = isObjectLike(document.root.metadata)
      ? document.root.metadata
      : {};
    const spec = isObjectLike(document.root.spec) ? document.root.spec : {};
    return [
      {
        apiVersion: getString(document.root.apiVersion),
        kind: 'HelmRepository',
        metadata: {
          name: getName(metadata) ?? '',
          namespace: getNamespace(metadata),
        },
        spec: spec as HelmRepositoryResource['spec'],
        documentUri: document.uri,
      } satisfies HelmRepositoryResource,
    ];
  });
}

function getPairValue(map: YAMLMap | undefined, key: string): Node | undefined {
  if (!map) {
    return undefined;
  }
  for (const item of map.items) {
    if (isScalar(item.key) && item.key.value === key) {
      return item.value as Node | undefined;
    }
  }
  return undefined;
}

function getPair(
  map: YAMLMap | undefined,
  key: string,
): Pair<unknown, unknown> | undefined {
  if (!map) {
    return undefined;
  }
  for (const item of map.items) {
    if (isScalar(item.key) && item.key.value === key) {
      return item;
    }
  }
  return undefined;
}

function positionToOffset(
  document: vscode.TextDocument,
  position: vscode.Position,
): number {
  return document.offsetAt(position);
}

function indentationOf(lineText: string): number {
  let count = 0;
  while (count < lineText.length && lineText[count] === ' ') {
    count += 1;
  }
  return count;
}

function isLikelyInValuesBlock(
  document: vscode.TextDocument,
  position: vscode.Position,
  valuesKeyOffset: number,
): boolean {
  const valuesStart = document.positionAt(valuesKeyOffset);
  const valuesIndent = indentationOf(document.lineAt(valuesStart.line).text);
  const currentLine = document.lineAt(position.line).text;
  const currentIndent = indentationOf(currentLine);
  return position.line > valuesStart.line && currentIndent > valuesIndent;
}

function nodeContainsOffset(node: Node | undefined, offset: number): boolean {
  if (!node?.range) {
    return false;
  }
  return offset >= node.range[0] && offset <= node.range[1];
}

function pairContainsOffset(
  pair: Pair<unknown, unknown> | undefined,
  offset: number,
): boolean {
  if (!pair) {
    return false;
  }
  return (
    nodeContainsOffset(pair.key as Node | undefined, offset) ||
    nodeContainsOffset(pair.value as Node | undefined, offset)
  );
}

export function findValuesContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): ValuesContext | undefined {
  const parsed = parseYamlDocuments(document.getText(), document.uri);
  const offset = positionToOffset(document, position);

  for (const item of parsed) {
    if (offset < item.startOffset || offset > item.endOffset) {
      continue;
    }
    if (!isHelmReleaseObject(item.root) || !isMap(item.yamlDocument.contents)) {
      continue;
    }
    const specNode = getPairValue(item.yamlDocument.contents, 'spec');
    if (!isMap(specNode)) {
      continue;
    }
    const valuesPair = getPair(specNode, 'values');
    const valuesNode = valuesPair?.value as Node | undefined;
    if (!valuesNode) {
      continue;
    }
    const valuesKeyOffset =
      (valuesPair?.key as Node | undefined)?.range?.[0] ??
      valuesNode.range?.[0] ??
      0;
    if (
      !pairContainsOffset(valuesPair, offset) &&
      !isLikelyInValuesBlock(document, position, valuesKeyOffset)
    ) {
      continue;
    }

    const metadata = isObjectLike(item.root.metadata) ? item.root.metadata : {};
    const spec = isObjectLike(item.root.spec) ? item.root.spec : {};
    return {
      release: {
        apiVersion: getString(item.root.apiVersion),
        kind: 'HelmRelease',
        metadata: {
          name: getName(metadata) ?? '',
          namespace: getNamespace(metadata),
        },
        spec: spec as HelmReleaseResource['spec'],
        documentUri: document.uri,
      },
      valuesNode,
      valuesKeyOffset,
      documentIndex: item.index,
    };
  }

  return undefined;
}

export function findAllValuesContexts(
  document: vscode.TextDocument,
): ValuesContext[] {
  const parsed = parseYamlDocuments(document.getText(), document.uri);
  return parsed.flatMap((item) => {
    if (!isHelmReleaseObject(item.root) || !isMap(item.yamlDocument.contents)) {
      return [];
    }
    const specNode = getPairValue(item.yamlDocument.contents, 'spec');
    if (!isMap(specNode)) {
      return [];
    }
    const valuesPair = getPair(specNode, 'values');
    const valuesNode = valuesPair?.value as Node | undefined;
    if (!valuesNode) {
      return [];
    }
    const valuesKeyOffset =
      (valuesPair?.key as Node | undefined)?.range?.[0] ??
      valuesNode.range?.[0] ??
      0;
    const metadata = isObjectLike(item.root.metadata) ? item.root.metadata : {};
    const spec = isObjectLike(item.root.spec) ? item.root.spec : {};
    return [
      {
        release: {
          apiVersion: getString(item.root.apiVersion),
          kind: 'HelmRelease',
          metadata: {
            name: getName(metadata) ?? '',
            namespace: getNamespace(metadata),
          },
          spec: spec as HelmReleaseResource['spec'],
          documentUri: document.uri,
        },
        valuesNode,
        valuesKeyOffset,
        documentIndex: item.index,
      } satisfies ValuesContext,
    ];
  });
}

async function collectWorkspaceYamlUris(): Promise<vscode.Uri[]> {
  const [yamlFiles, ymlFiles] = await Promise.all([
    vscode.workspace.findFiles('**/*.yaml', YAML_EXCLUDE_PATTERN),
    vscode.workspace.findFiles('**/*.yml', YAML_EXCLUDE_PATTERN),
  ]);
  return [...yamlFiles, ...ymlFiles];
}

async function collectNearbyYamlUris(
  activeUri: vscode.Uri,
): Promise<vscode.Uri[]> {
  const directory = path.dirname(activeUri.fsPath);
  const [yamlFiles, ymlFiles] = await Promise.all([
    vscode.workspace.findFiles(new vscode.RelativePattern(directory, '*.yaml')),
    vscode.workspace.findFiles(new vscode.RelativePattern(directory, '*.yml')),
  ]);
  return [...yamlFiles, ...ymlFiles].filter(
    (uri) => uri.toString() !== activeUri.toString(),
  );
}

export function invalidateWorkspaceRepositoryCache(): void {
  repositoryCache = undefined;
  repositoryCachePromise = undefined;
  configuredRepositoryCache = undefined;
  configuredRepositoryCachePromise = undefined;
}

export async function loadWorkspaceRepositories(
  activeUri?: vscode.Uri,
): Promise<HelmRepositoryResource[]> {
  if (
    repositoryCache &&
    Date.now() - repositoryCache.loadedAt < REPOSITORY_CACHE_TTL_MS
  ) {
    return activeUri
      ? repositoryCache.repositories.filter(
          (repo) => repo.documentUri.toString() !== activeUri.toString(),
        )
      : repositoryCache.repositories;
  }

  if (repositoryCachePromise) {
    const repositories = await repositoryCachePromise;
    return activeUri
      ? repositories.filter(
          (repo) => repo.documentUri.toString() !== activeUri.toString(),
        )
      : repositories;
  }

  repositoryCachePromise = (async () => {
    const uris = await collectWorkspaceYamlUris();
    const repositories: HelmRepositoryResource[] = [];
    for (const uri of uris) {
      if (activeUri && uri.toString() === activeUri.toString()) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      repositories.push(...getHelmRepositories(parseYamlDocuments(text, uri)));
    }
    repositoryCache = {
      repositories,
      loadedAt: Date.now(),
    };
    repositoryCachePromise = undefined;
    return repositories;
  })().catch((error) => {
    repositoryCachePromise = undefined;
    throw error;
  });

  const repositories = await repositoryCachePromise;
  return activeUri
    ? repositories.filter(
        (repo) => repo.documentUri.toString() !== activeUri.toString(),
      )
    : repositories;
}

export async function loadSiblingRepositories(
  activeUri: vscode.Uri,
): Promise<HelmRepositoryResource[]> {
  const uris = await collectNearbyYamlUris(activeUri);
  const repositories: HelmRepositoryResource[] = [];
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    repositories.push(...getHelmRepositories(parseYamlDocuments(text, uri)));
  }
  return repositories;
}

function getConfiguredRepositorySearchPaths(): string[] {
  return vscode.workspace
    .getConfiguration('fluxHelmValues')
    .get<string[]>('repositorySearchPaths', [])
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function normalizeConfiguredPath(
  entry: string,
  workspaceFolder?: string,
): string {
  if (path.isAbsolute(entry)) {
    return path.normalize(entry);
  }
  return path.normalize(path.join(workspaceFolder ?? process.cwd(), entry));
}

function splitGlobBase(pattern: string): { base: string; pattern: string } {
  const parsed = path.parse(pattern);
  const relative = pattern.slice(parsed.root.length);
  const segments = relative.split(path.sep);
  const globIndex = segments.findIndex((segment) => hasGlobPattern(segment));
  if (globIndex === -1) {
    return { base: pattern, pattern: YAML_FILE_PATTERN };
  }
  const baseSegments = segments.slice(0, globIndex);
  const patternSegments = segments.slice(globIndex);
  return {
    base: path.join(parsed.root, ...baseSegments),
    pattern: patternSegments.join('/'),
  };
}

async function collectYamlUrisFromConfiguredPath(
  entry: string,
): Promise<vscode.Uri[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders?.map(
    (folder) => folder.uri.fsPath,
  ) ?? [undefined];
  const uris: vscode.Uri[] = [];

  for (const workspaceFolder of workspaceFolders) {
    const target = normalizeConfiguredPath(entry, workspaceFolder);
    if (hasGlobPattern(target)) {
      const glob = splitGlobBase(target);
      uris.push(
        ...(await vscode.workspace.findFiles(
          new vscode.RelativePattern(glob.base, glob.pattern),
          YAML_EXCLUDE_PATTERN,
        )),
      );
      continue;
    }

    try {
      const stat = await fs.stat(target);
      if (stat.isFile() && /\.(ya?ml)$/i.test(target)) {
        uris.push(vscode.Uri.file(target));
      }
      if (stat.isDirectory()) {
        uris.push(
          ...(await vscode.workspace.findFiles(
            new vscode.RelativePattern(target, YAML_FILE_PATTERN),
            YAML_EXCLUDE_PATTERN,
          )),
        );
      }
    } catch {
      // Ignore missing or unreadable configured paths. Resolution will continue.
    }
  }

  return uris;
}

async function readYamlDocumentText(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return fs.readFile(uri.fsPath, 'utf8');
  }
}

export async function loadConfiguredRepositories(): Promise<
  HelmRepositoryResource[]
> {
  const searchPaths = getConfiguredRepositorySearchPaths();
  if (searchPaths.length === 0) {
    return [];
  }

  const cacheKey = JSON.stringify(searchPaths);
  if (
    configuredRepositoryCache &&
    configuredRepositoryCache.cacheKey === cacheKey &&
    Date.now() - configuredRepositoryCache.loadedAt < REPOSITORY_CACHE_TTL_MS
  ) {
    return configuredRepositoryCache.repositories;
  }

  if (configuredRepositoryCachePromise) {
    return configuredRepositoryCachePromise;
  }

  configuredRepositoryCachePromise = (async () => {
    const seen = new Set<string>();
    const repositories: HelmRepositoryResource[] = [];
    for (const searchPath of searchPaths) {
      const uris = await collectYamlUrisFromConfiguredPath(searchPath);
      for (const uri of uris) {
        const key = uri.toString();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const text = await readYamlDocumentText(uri);
        repositories.push(
          ...getHelmRepositories(parseYamlDocuments(text, uri)),
        );
      }
    }
    configuredRepositoryCache = {
      repositories,
      loadedAt: Date.now(),
      cacheKey,
    };
    configuredRepositoryCachePromise = undefined;
    return repositories;
  })().catch((error) => {
    configuredRepositoryCachePromise = undefined;
    throw error;
  });

  return configuredRepositoryCachePromise;
}

export async function resolveChartForDocument(
  document: vscode.TextDocument,
  position?: vscode.Position,
): Promise<ResolvedChart | undefined> {
  const context = position ? findValuesContext(document, position) : undefined;
  const parsed = parseYamlDocuments(document.getText(), document.uri);
  const releases = getHelmReleases(parsed);
  const targetRelease = context?.release ?? releases[0];
  if (!targetRelease) {
    return undefined;
  }

  const sameFileRepos = getHelmRepositories(parsed);
  const siblingRepos = await loadSiblingRepositories(document.uri);
  const workspaceRepos = await loadWorkspaceRepositories(document.uri);
  const localRepos = [...sameFileRepos, ...siblingRepos, ...workspaceRepos];
  const locallyResolved = resolveChartFromResources(targetRelease, localRepos);
  if (locallyResolved) {
    return locallyResolved;
  }

  const configuredRepos = await loadConfiguredRepositories();
  return resolveChartFromResources(targetRelease, [
    ...localRepos,
    ...configuredRepos,
  ]);
}

export function resolveChartFromResources(
  release: HelmReleaseResource,
  repositories: HelmRepositoryResource[],
): ResolvedChart | undefined {
  const chartSpec = release.spec.chart?.spec;
  const sourceRef = chartSpec?.sourceRef;
  const chart = chartSpec?.chart;
  if (!sourceRef || !chart) {
    return undefined;
  }

  const targetNamespace = sourceRef.namespace ?? release.metadata.namespace;
  const matchingRepositories = repositories.filter((repo) => {
    return (
      repo.kind === sourceRef.kind && repo.metadata.name === sourceRef.name
    );
  });

  const repository =
    matchingRepositories.find((repo) => {
      return (repo.metadata.namespace ?? '') === (targetNamespace ?? '');
    }) ??
    matchingRepositories.find((repo) => {
      return repo.metadata.namespace === undefined;
    });

  if (!repository?.spec.url) {
    return undefined;
  }

  const repoUrl = repository.spec.url;
  return {
    release,
    repository,
    chart,
    version: chartSpec.version,
    repoUrl,
    isOci: repoUrl.startsWith('oci://') || repository.spec.type === 'oci',
  };
}

export function getYamlPathAtOffset(
  root: Node | undefined,
  offset: number,
): string[] {
  if (!root) {
    return [];
  }

  let bestPath: string[] = [];

  const visitNodeAtPath = (
    node: Node | undefined,
    currentPath: string[],
  ): void => {
    if (!nodeContainsOffset(node, offset)) {
      return;
    }

    if (currentPath.length >= bestPath.length) {
      bestPath = [...currentPath];
    }

    if (isMap(node)) {
      for (const item of node.items) {
        if (!isScalar(item.key) || typeof item.key.value !== 'string') {
          continue;
        }
        const nextPath = [...currentPath, item.key.value];
        if (nodeContainsOffset(item.key as Node, offset)) {
          if (nextPath.length >= bestPath.length) {
            bestPath = nextPath;
          }
        }
        visitNodeAtPath(item.value as Node | undefined, nextPath);
      }
      return;
    }

    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        visitNodeAtPath(item as Node | undefined, [
          ...currentPath,
          String(index),
        ]);
      });
    }
  };

  visitNodeAtPath(root, []);
  return bestPath;
}

export function getNodeAtPath(
  root: Node | undefined,
  path: string[],
): Node | undefined {
  let current = root;
  for (const segment of path) {
    if (isMap(current)) {
      current = getPairValue(current, segment);
      continue;
    }
    if (isSeq(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isNaN(index)
        ? undefined
        : (current.items[index] as Node | undefined);
      continue;
    }
    return undefined;
  }
  return current;
}

export function getMapEntries(
  node: Node | undefined,
): Array<{ key: string; value: Node | undefined }> {
  if (!isMap(node)) {
    return [];
  }
  return node.items.flatMap((item: Pair<unknown, unknown>) => {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') {
      return [];
    }
    return [{ key: item.key.value, value: item.value as Node | undefined }];
  });
}

export function describeNodeValue(node: Node | undefined): unknown {
  if (!node) {
    return undefined;
  }
  if (isScalar(node)) {
    return (node as Scalar).value;
  }
  if (isSeq(node)) {
    return node.items.map((item) =>
      describeNodeValue(item as Node | undefined),
    );
  }
  if (isMap(node)) {
    return Object.fromEntries(
      getMapEntries(node).map((entry) => [
        entry.key,
        describeNodeValue(entry.value),
      ]),
    );
  }
  return undefined;
}
