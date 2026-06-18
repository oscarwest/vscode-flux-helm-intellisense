import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildHelmPullInvocation,
  ChartCache,
  checkHelmExecutable,
  formatHelmError,
  formatHelmInvocationForShell,
} from '../src/helm';
import type { ResolvedChart } from '../src/types';

function createResolvedChart(overrides: Partial<ResolvedChart>): ResolvedChart {
  return {
    release: {
      kind: 'HelmRelease',
      metadata: { name: 'demo', namespace: 'apps' },
      spec: {},
      documentUri: vscode.Uri.file('/workspace/release.yaml'),
    },
    repository: {
      kind: 'HelmRepository',
      metadata: { name: 'repo', namespace: 'apps' },
      spec: { url: 'https://charts.example.com' },
      documentUri: vscode.Uri.file('/workspace/repo.yaml'),
    },
    chart: 'demo',
    version: '1.2.3',
    repoUrl: 'https://charts.example.com',
    isOci: false,
    ...overrides,
  };
}

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'flux-helm-values-'));
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe('helm pull invocation', () => {
  it('builds HTTP repository pull arguments', () => {
    const invocation = buildHelmPullInvocation(
      'helm',
      createResolvedChart({}),
      '/tmp/cache',
    );

    expect(invocation.executable).toBe('helm');
    expect(invocation.chartRef).toBe('demo');
    expect(invocation.args).toEqual([
      'pull',
      'demo',
      '--repo',
      'https://charts.example.com',
      '--version',
      '1.2.3',
      '--untar',
      '--untardir',
      '/tmp/cache/pull',
    ]);
  });

  it('builds OCI pull arguments', () => {
    const invocation = buildHelmPullInvocation(
      'helm',
      createResolvedChart({
        repoUrl: 'oci://ghcr.io/prometheus-community/charts',
        chart: 'kube-prometheus-stack',
        isOci: true,
      }),
      '/tmp/cache',
    );

    expect(invocation.chartRef).toBe(
      'oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack',
    );
    expect(invocation.args).toEqual([
      'pull',
      'oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack',
      '--version',
      '1.2.3',
      '--untar',
      '--untardir',
      '/tmp/cache/pull',
    ]);
  });

  it('formats helm invocations for POSIX shells', () => {
    const invocation = buildHelmPullInvocation(
      'helm',
      createResolvedChart({}),
      '/tmp/cache dir',
    );

    const commandText = formatHelmInvocationForShell(invocation, 'darwin');

    expect(commandText).toContain("'helm'");
    expect(commandText).toContain("'/tmp/cache dir/pull'");
  });

  it('checks helm setup with version output', async () => {
    const runHelm = vi.fn(async () => ({ stdout: 'v3.18.0\n', stderr: '' }));

    const version = await checkHelmExecutable('helm', runHelm as any);

    expect(version).toBe('v3.18.0');
    expect(runHelm).toHaveBeenCalledWith(
      'helm',
      ['version', '--short'],
      expect.any(Object),
    );
  });

  it('formats helm pull failures with exit code and command output', () => {
    const error = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: 'partial output\n',
      stderr: 'Error: chart not found\n',
    });

    const formatted = formatHelmError(error, 'helm').message;

    expect(formatted).toContain("Helm command failed using 'helm'.");
    expect(formatted).toContain('Exit code: 1.');
    expect(formatted).toContain('stderr: Error: chart not found');
    expect(formatted).toContain('stdout: partial output');
  });

  it('adds a private OCI auth hint for authorization failures', () => {
    const error = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: 'Error: unexpected status from HEAD request: 401 Unauthorized',
    });
    const chart = createResolvedChart({
      repoUrl: 'oci://acrvcedcsp.azurecr.io/helm/dev',
      isOci: true,
      version: '*',
    });
    const invocation = buildHelmPullInvocation('helm', chart, '/tmp/cache dir');

    const formatted = formatHelmError(error, 'helm', chart, invocation).message;

    expect(formatted).toContain(
      "Command: 'helm' 'pull' 'oci://acrvcedcsp.azurecr.io/helm/dev/demo' '--version' '*'",
    );
    expect(formatted).toContain('Exit code: 1.');
    expect(formatted).toContain('401 Unauthorized');
    expect(formatted).toContain('helm registry login acrvcedcsp.azurecr.io');
  });

  it('loads metadata from mocked helm output and reuses fresh cache entries', async () => {
    const storageDir = await createTempDir();
    const runHelm = vi.fn(
      async (
        _executable: string,
        _args: string[],
        options?: { cwd?: string },
      ) => {
        const chartDir = path.join(options?.cwd ?? storageDir, 'pull', 'demo');
        await fs.mkdir(chartDir, { recursive: true });
        await fs.writeFile(
          path.join(chartDir, 'Chart.yaml'),
          'apiVersion: v2\nname: demo\nversion: 9.9.9\n',
          'utf8',
        );
        await fs.writeFile(
          path.join(chartDir, 'values.schema.json'),
          JSON.stringify({ type: 'object' }),
          'utf8',
        );
        await fs.writeFile(
          path.join(chartDir, 'values.yaml'),
          'replicaCount: 1\n',
          'utf8',
        );
        return { stdout: '', stderr: '' };
      },
    );
    const cache = new ChartCache(
      {
        globalStorageUri: vscode.Uri.file(storageDir),
      } as vscode.ExtensionContext,
      {
        runHelm,
        now: () => 1_000,
      },
    );

    const first = await cache.load(createResolvedChart({}), false);
    const second = await cache.load(createResolvedChart({}), false);

    expect(runHelm).toHaveBeenCalledTimes(1);
    expect(first.valuesSchemaPath).toBe(
      path.join(first.chartDir, 'values.schema.json'),
    );
    expect(first.valuesPath).toBe(path.join(first.chartDir, 'values.yaml'));
    expect(first.resolvedVersion).toBe('9.9.9');
    expect(second.chartDir).toBe(first.chartDir);
  });

  it('memoizes failed helm pulls for the short failure TTL', async () => {
    const storageDir = await createTempDir();
    const runHelm = vi.fn(async () => {
      throw new Error('helm pull failed');
    });
    let now = 5_000;
    const cache = new ChartCache(
      {
        globalStorageUri: vscode.Uri.file(storageDir),
      } as vscode.ExtensionContext,
      {
        runHelm,
        now: () => now,
      },
    );

    await expect(cache.load(createResolvedChart({}), false)).rejects.toThrow(
      'helm pull failed',
    );
    expect(runHelm).toHaveBeenCalledTimes(1);

    now += 60_000;
    await expect(cache.load(createResolvedChart({}), false)).rejects.toThrow(
      'helm pull failed',
    );
    expect(runHelm).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent loads for the same chart cache key', async () => {
    const storageDir = await createTempDir();
    let releaseHelm: (() => Promise<void>) | undefined;
    let helmStarted: (() => void) | undefined;
    const helmStartedPromise = new Promise<void>((resolve) => {
      helmStarted = resolve;
    });
    const runHelm = vi.fn(
      async (
        _executable: string,
        _args: string[],
        options?: { cwd?: string },
      ) => {
        await new Promise<void>((resolve) => {
          helmStarted?.();
          releaseHelm = async () => {
            const chartDir = path.join(
              options?.cwd ?? storageDir,
              'pull',
              'istiod',
            );
            await fs.mkdir(chartDir, { recursive: true });
            await fs.writeFile(
              path.join(chartDir, 'Chart.yaml'),
              'apiVersion: v2\nname: istiod\nversion: 1.29.4\n',
              'utf8',
            );
            await fs.writeFile(
              path.join(chartDir, 'values.yaml'),
              'resources: {}\n',
              'utf8',
            );
            resolve();
          };
        });
        return { stdout: '', stderr: '' };
      },
    );
    const cache = new ChartCache(
      {
        globalStorageUri: vscode.Uri.file(storageDir),
      } as vscode.ExtensionContext,
      {
        runHelm,
        now: () => 10_000,
      },
    );
    const chart = createResolvedChart({
      chart: 'istiod',
      version: '1.29.4',
      repoUrl: 'https://istio-release.storage.googleapis.com/charts',
    });

    const first = cache.load(chart, false);
    const second = cache.load(chart, false);
    await helmStartedPromise;
    await releaseHelm?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(runHelm).toHaveBeenCalledTimes(1);
    expect(firstResult.chartDir).toBe(secondResult.chartDir);
    expect(firstResult.resolvedVersion).toBe('1.29.4');
  });
});
