import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import type { ChartLoadFailure, ChartMetadata, ResolvedChart } from './types';

const execFileAsync = promisify(execFile);
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_FILTERED_VERSION_CANDIDATES = 25;

type HelmRunner = typeof execFileAsync;

interface ChartCacheDependencies {
  runHelm?: HelmRunner;
  now?: () => number;
}

export interface HelmPullInvocation {
  executable: string;
  args: string[];
  chartRef: string;
}

interface CacheEntry {
  metadata?: ChartMetadata;
  failure?: ChartLoadFailure;
}

interface HelmProcessError extends Error {
  code?: string | number;
  signal?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

class HelmInvocationFailure extends Error {
  public constructor(
    public readonly cause: unknown,
    public readonly invocation: HelmPullInvocation,
  ) {
    super(cause instanceof Error ? cause.message : 'Helm command failed.');
  }
}

class OCIReferenceResolutionError extends Error {}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePowerShell(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}

function formatCommandOutput(value: unknown): string | undefined {
  const output = `${value ?? ''}`.trim();
  return output.length > 0 ? output : undefined;
}

function looksLikeAuthFailure(message: string): boolean {
  return /\b(401|403|unauthorized|forbidden|denied|authentication required|no basic auth credentials)\b/i.test(
    message,
  );
}

function ociRegistryHost(repoUrl: string): string | undefined {
  if (!repoUrl.startsWith('oci://')) {
    return undefined;
  }
  return repoUrl.replace(/^oci:\/\//, '').split('/')[0];
}

export function formatHelmError(
  error: unknown,
  helmPath: string,
  resolvedChart?: ResolvedChart,
  invocation?: HelmPullInvocation,
): Error {
  if (error instanceof HelmInvocationFailure) {
    return formatHelmError(
      error.cause,
      helmPath,
      resolvedChart,
      error.invocation,
    );
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  ) {
    return new Error(
      `Helm executable not found at '${helmPath}'. Install Helm or set fluxHelmValues.helmPath to the correct executable path.`,
    );
  }

  if (error instanceof Error) {
    const helmError = error as HelmProcessError;
    const parts = [`Helm command failed using '${helmPath}'.`];
    if (invocation) {
      parts.push(`Command: ${formatHelmInvocationForShell(invocation)}`);
    }
    if (helmError.code !== undefined) {
      parts.push(`Exit code: ${helmError.code}.`);
    }
    if (helmError.signal) {
      parts.push(`Signal: ${helmError.signal}.`);
    }
    const stderr = formatCommandOutput(helmError.stderr);
    const stdout = formatCommandOutput(helmError.stdout);
    if (stderr) {
      parts.push(`stderr: ${stderr}`);
    }
    if (stdout) {
      parts.push(`stdout: ${stdout}`);
    }
    if (!stderr && !stdout && error.message) {
      parts.push(error.message);
    }

    const message = parts.join('\n');
    const registryHost = resolvedChart
      ? ociRegistryHost(resolvedChart.repoUrl)
      : undefined;
    if (registryHost && looksLikeAuthFailure(message)) {
      parts.push(
        `Private OCI registry authentication may be required. Run 'helm registry login ${registryHost}' or your provider login command, then retry.`,
      );
    }

    return new Error(parts.join('\n'));
  }
  return new Error(`Helm command failed using '${helmPath}'.`);
}

export async function checkHelmExecutable(
  helmPath: string,
  runHelm: HelmRunner = execFileAsync,
): Promise<string> {
  const result = await runHelm(helmPath, ['version', '--short'], {
    env: process.env,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return (
    `${result.stdout}`.trim() ||
    `${result.stderr}`.trim() ||
    'Helm is available'
  );
}

export function formatHelmInvocationForShell(
  invocation: HelmPullInvocation,
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === 'win32' ? shellQuotePowerShell : shellQuotePosix;
  return [invocation.executable, ...invocation.args].map(quote).join(' ');
}

export function buildHelmPullInvocation(
  helmPath: string,
  resolvedChart: ResolvedChart,
  untarDir: string,
): HelmPullInvocation {
  const targetDir = path.join(untarDir, 'pull');
  const version = resolvedChart.version;
  if (resolvedChart.isOci) {
    const chartRef = buildOCIChartReference(resolvedChart);
    return {
      executable: helmPath,
      chartRef,
      args: [
        'pull',
        chartRef,
        ...(version ? ['--version', version] : []),
        '--untar',
        '--untardir',
        targetDir,
      ],
    };
  }

  return {
    executable: helmPath,
    chartRef: resolvedChart.chart,
    args: [
      'pull',
      resolvedChart.chart,
      '--repo',
      resolvedChart.repoUrl,
      ...(version ? ['--version', version] : []),
      '--untar',
      '--untardir',
      targetDir,
    ],
  };
}

function buildOCIChartReference(resolvedChart: ResolvedChart): string {
  const base = `${resolvedChart.repoUrl.replace(/\/$/, '')}/${resolvedChart.chart}`;
  if (resolvedChart.digest) {
    return `${base}@${resolvedChart.digest}`;
  }
  if (resolvedChart.tag) {
    return `${base}:${resolvedChart.tag}`;
  }
  return base;
}

function buildHelmShowInvocation(
  helmPath: string,
  resolvedChart: ResolvedChart,
  version: string,
): HelmPullInvocation {
  const chartRef = buildOCIChartReference({
    ...resolvedChart,
    tag: undefined,
    digest: undefined,
  });
  return {
    executable: helmPath,
    chartRef,
    args: ['show', 'chart', chartRef, '--version', version],
  };
}

function extractChartVersion(stdout: unknown): string | undefined {
  return `${stdout ?? ''}`
    .split(/\r?\n/)
    .find((line) => line.startsWith('version:'))
    ?.slice('version:'.length)
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

function matchesSemverFilter(version: string, filter: RegExp): boolean {
  const registryTag = version.replace(/\+/g, '_');
  filter.lastIndex = 0;
  return filter.test(registryTag);
}

function constrainSemverBelow(constraint: string, version: string): string {
  return constraint
    .split(/\s*\|\|\s*/)
    .map((branch) => {
      const normalized = branch.trim();
      return normalized === '' || normalized === '*'
        ? `< ${version}`
        : `${normalized}, < ${version}`;
    })
    .join(' || ');
}

async function resolveFilteredOCIChartVersion(
  helmPath: string,
  resolvedChart: ResolvedChart,
  runHelm: HelmRunner,
  cwd: string,
): Promise<string> {
  const requestedVersion = resolvedChart.version;
  const filterText = resolvedChart.semverFilter;
  if (!requestedVersion || !filterText) {
    throw new OCIReferenceResolutionError(
      'Filtered OCI version resolution requires both semver and semverFilter.',
    );
  }

  let filter: RegExp;
  try {
    filter = new RegExp(filterText);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new OCIReferenceResolutionError(
      `Invalid OCIRepository semverFilter '${filterText}'.${detail}`,
    );
  }

  let constraint = requestedVersion;
  const seen = new Set<string>();
  for (
    let attempt = 0;
    attempt < MAX_FILTERED_VERSION_CANDIDATES;
    attempt += 1
  ) {
    const invocation = buildHelmShowInvocation(
      helmPath,
      resolvedChart,
      constraint,
    );
    let result: Awaited<ReturnType<HelmRunner>>;
    try {
      result = await runHelm(invocation.executable, invocation.args, {
        env: process.env,
        cwd,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      throw new HelmInvocationFailure(error, invocation);
    }

    const candidate = extractChartVersion(result.stdout);
    if (!candidate) {
      throw new OCIReferenceResolutionError(
        `Helm did not report a chart version while resolving semver '${requestedVersion}' with filter '${filterText}'.`,
      );
    }
    if (seen.has(candidate)) {
      throw new OCIReferenceResolutionError(
        `Helm repeatedly resolved OCI chart version '${candidate}' while applying semverFilter '${filterText}'.`,
      );
    }
    seen.add(candidate);

    if (matchesSemverFilter(candidate, filter)) {
      return candidate;
    }
    constraint = constrainSemverBelow(requestedVersion, candidate);
  }

  throw new OCIReferenceResolutionError(
    `No matching OCI chart version was found after checking ${MAX_FILTERED_VERSION_CANDIDATES} candidates for semver '${requestedVersion}' with filter '${filterText}'.`,
  );
}

function createCacheKey(chart: ResolvedChart): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        repoUrl: chart.repoUrl,
        chart: chart.chart,
        requestedVersion: chart.version ?? '',
        requestedTag: chart.tag ?? '',
        requestedDigest: chart.digest ?? '',
        semverFilter: chart.semverFilter ?? '',
        releaseNamespace: chart.release.metadata.namespace ?? '',
        repositoryNamespace: chart.repository.metadata.namespace ?? '',
      }),
    )
    .digest('hex');
}

function createRunId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(targetPath: string): Promise<T | undefined> {
  if (!(await fileExists(targetPath))) {
    return undefined;
  }
  const contents = await fs.readFile(targetPath, 'utf8');
  return JSON.parse(contents) as T;
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2), 'utf8');
}

async function findChartDirectory(
  rootDir: string,
): Promise<string | undefined> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const firstDir = entries.find((entry) => entry.isDirectory());
  return firstDir ? path.join(rootDir, firstDir.name) : undefined;
}

async function discoverMetadata(chartDir: string): Promise<ChartMetadata> {
  const valuesSchemaPath = path.join(chartDir, 'values.schema.json');
  const valuesPath = path.join(chartDir, 'values.yaml');
  const chartYamlPath = path.join(chartDir, 'Chart.yaml');
  let resolvedVersion: string | undefined;

  if (await fileExists(chartYamlPath)) {
    const chartYaml = await fs.readFile(chartYamlPath, 'utf8');
    resolvedVersion = extractChartVersion(chartYaml);
  }

  return {
    chartDir,
    valuesSchemaPath: (await fileExists(valuesSchemaPath))
      ? valuesSchemaPath
      : undefined,
    valuesPath: (await fileExists(valuesPath)) ? valuesPath : undefined,
    fetchedAt: Date.now(),
    resolvedVersion,
  };
}

export class ChartCache {
  private readonly storageDir: string;
  private readonly runHelm: HelmRunner;
  private readonly now: () => number;
  private readonly inFlightLoads = new Map<string, Promise<ChartMetadata>>();

  public constructor(
    context: vscode.ExtensionContext,
    dependencies: ChartCacheDependencies = {},
  ) {
    this.storageDir = context.globalStorageUri.fsPath;
    this.runHelm = dependencies.runHelm ?? execFileAsync;
    this.now = dependencies.now ?? (() => Date.now());
  }

  public async clear(): Promise<void> {
    await fs.rm(this.storageDir, { recursive: true, force: true });
    await ensureDir(this.storageDir);
  }

  public async refresh(
    resolvedChart: ResolvedChart,
    force: boolean,
  ): Promise<ChartMetadata> {
    return this.load(resolvedChart, force);
  }

  public async load(
    resolvedChart: ResolvedChart,
    force = false,
  ): Promise<ChartMetadata> {
    await ensureDir(this.storageDir);
    const key = createCacheKey(resolvedChart);
    const entryDir = path.join(this.storageDir, key);
    const entryPath = path.join(entryDir, 'entry.json');
    const entry = await readJson<CacheEntry>(entryPath);
    const ttlHours = vscode.workspace
      .getConfiguration('fluxHelmValues')
      .get<number>('cacheTtlHours', 24);
    const ttlMs = ttlHours * 60 * 60 * 1000;

    if (
      !force &&
      entry?.metadata &&
      this.now() - entry.metadata.fetchedAt < ttlMs
    ) {
      return entry.metadata;
    }

    if (
      !force &&
      entry?.failure &&
      this.now() - entry.failure.failedAt < FAILURE_TTL_MS
    ) {
      throw new Error(entry.failure.message);
    }

    const existingLoad = this.inFlightLoads.get(key);
    if (existingLoad) {
      return existingLoad;
    }

    const pendingLoad = (async () => {
      await fs.rm(entryDir, { recursive: true, force: true });
      await ensureDir(entryDir);
      const runDir = path.join(entryDir, `run-${createRunId()}`);
      await ensureDir(runDir);

      const helmPath = vscode.workspace
        .getConfiguration('fluxHelmValues')
        .get<string>('helmPath', 'helm');
      let invocation: HelmPullInvocation | undefined;

      try {
        const effectiveChart = resolvedChart.semverFilter
          ? {
              ...resolvedChart,
              version: await resolveFilteredOCIChartVersion(
                helmPath,
                resolvedChart,
                this.runHelm,
                runDir,
              ),
              semverFilter: undefined,
            }
          : resolvedChart;
        invocation = buildHelmPullInvocation(helmPath, effectiveChart, runDir);
        await this.runHelm(invocation.executable, invocation.args, {
          env: process.env,
          cwd: runDir,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        });
        const chartDir = await findChartDirectory(path.join(runDir, 'pull'));
        if (!chartDir) {
          throw new Error(
            'Helm pull completed but no chart directory was created.',
          );
        }
        const metadata = await discoverMetadata(chartDir);
        await writeJson(entryPath, { metadata } satisfies CacheEntry);
        return metadata;
      } catch (error) {
        const message =
          error instanceof OCIReferenceResolutionError
            ? error.message
            : formatHelmError(error, helmPath, resolvedChart, invocation)
                .message;
        await writeJson(entryPath, {
          failure: { message, failedAt: this.now() },
        } satisfies CacheEntry);
        throw new Error(message);
      } finally {
        this.inFlightLoads.delete(key);
      }
    })();

    this.inFlightLoads.set(key, pendingLoad);
    return pendingLoad;
  }
}
