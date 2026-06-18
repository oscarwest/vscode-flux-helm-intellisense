import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ChartLoadFailure, ChartMetadata, ResolvedChart } from './types';

const execFileAsync = promisify(execFile);
const FAILURE_TTL_MS = 5 * 60 * 1000;

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

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePowerShell(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}

function formatHelmError(error: unknown, helmPath: string): Error {
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
    return error;
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
    return {
      executable: helmPath,
      chartRef: `${resolvedChart.repoUrl.replace(/\/$/, '')}/${resolvedChart.chart}`,
      args: [
        'pull',
        `${resolvedChart.repoUrl.replace(/\/$/, '')}/${resolvedChart.chart}`,
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

function createCacheKey(chart: ResolvedChart): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        repoUrl: chart.repoUrl,
        chart: chart.chart,
        requestedVersion: chart.version ?? '',
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
    const versionLine = chartYaml
      .split(/\r?\n/)
      .find((line) => line.startsWith('version:'));
    resolvedVersion = versionLine?.slice('version:'.length).trim();
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
    private readonly context: vscode.ExtensionContext,
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
      const invocation = buildHelmPullInvocation(
        helmPath,
        resolvedChart,
        runDir,
      );

      try {
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
        const message = formatHelmError(error, helmPath).message;
        await writeJson(entryPath, {
          failure: { message, failedAt: this.now() },
        } satisfies CacheEntry);
        throw formatHelmError(error, helmPath);
      } finally {
        this.inFlightLoads.delete(key);
      }
    })();

    this.inFlightLoads.set(key, pendingLoad);
    return pendingLoad;
  }
}
