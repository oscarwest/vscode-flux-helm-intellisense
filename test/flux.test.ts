import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  findAllValuesContexts,
  findValuesContext,
  getHelmReleases,
  getHelmRepositories,
  parseYamlDocuments,
  resolveChartForDocument,
  resolveChartFromResources,
} from '../src/flux';
import { createTextDocument, positionOf } from './helpers';

const fixtureRoot = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'infrastructure',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flux parsing and resolution', () => {
  it('parses multi-document YAML fixtures', async () => {
    const fixturePath = path.join(fixtureRoot, 'spegel', 'spegel.yaml');
    const text = await fs.readFile(fixturePath, 'utf8');
    const documents = parseYamlDocuments(text, vscode.Uri.file(fixturePath));

    expect(documents).toHaveLength(2);
    expect(getHelmRepositories(documents)).toHaveLength(1);
    expect(getHelmReleases(documents)).toHaveLength(1);
  });

  it('detects cursor positions under spec.values only', async () => {
    const fixturePath = path.join(
      fixtureRoot,
      'base',
      'controllers',
      'cert-manager.yaml',
    );
    const text = await fs.readFile(fixturePath, 'utf8');

    const inside = positionOf(text, 'installCRDs', fixturePath);
    const outside = positionOf(text, 'chart: cert-manager', fixturePath);

    expect(
      findValuesContext(
        inside.document as vscode.TextDocument,
        inside.position,
      ),
    ).toBeDefined();
    expect(
      findValuesContext(
        outside.document as vscode.TextDocument,
        outside.position,
      ),
    ).toBeUndefined();
    expect(
      findAllValuesContexts(inside.document as vscode.TextDocument),
    ).toHaveLength(1);
  });

  it('resolves HelmRepository by release namespace when sourceRef namespace is absent', async () => {
    const releasePath = path.join(
      fixtureRoot,
      'timescaledb',
      'dev',
      'operator',
      'releases.yaml',
    );
    const repoPath = path.join(
      fixtureRoot,
      'base',
      'controllers',
      'cert-manager.yaml',
    );
    const releaseText = await fs.readFile(releasePath, 'utf8');
    const repoText = await fs.readFile(repoPath, 'utf8');

    const release = getHelmReleases(
      parseYamlDocuments(releaseText, vscode.Uri.file(releasePath)),
    )[0];
    const repos = [
      {
        ...getHelmRepositories(
          parseYamlDocuments(repoText, vscode.Uri.file(repoPath)),
        )[0],
        metadata: {
          name: 'timescale-charts',
          namespace: 'data-platform',
        },
        spec: {
          url: 'https://charts.timescale.com',
        },
      },
    ];

    const resolved = resolveChartFromResources(release, repos);
    expect(resolved?.repoUrl).toBe('https://charts.timescale.com');
    expect(resolved?.chart).toBe('timescaledb-single');
  });

  it('prefers explicitly declared namespace on sourceRef', async () => {
    const text = `apiVersion: helm.toolkit.fluxcd.io/v2beta2\nkind: HelmRelease\nmetadata:\n  name: app\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: demo\n      sourceRef:\n        kind: HelmRepository\n        name: shared\n        namespace: platform\n  values:\n    replicaCount: 1\n`;
    const release = getHelmReleases(
      parseYamlDocuments(text, vscode.Uri.file('/workspace/release.yaml')),
    )[0];
    const repos = [
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
        kind: 'HelmRepository',
        metadata: { name: 'shared', namespace: 'apps' },
        spec: { url: 'https://wrong.example.com' },
        documentUri: vscode.Uri.file('/workspace/apps-repo.yaml'),
      },
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
        kind: 'HelmRepository',
        metadata: { name: 'shared', namespace: 'platform' },
        spec: { url: 'https://correct.example.com' },
        documentUri: vscode.Uri.file('/workspace/platform-repo.yaml'),
      },
    ];

    const resolved = resolveChartFromResources(release, repos);
    expect(resolved?.repoUrl).toBe('https://correct.example.com');
  });

  it('resolves HelmRepository from a sibling repos file in the same directory', async () => {
    const releasePath =
      '/workspace/infrastructure/monitoring-stack/dev/setup/releases.yaml';
    const repoPath =
      '/workspace/infrastructure/monitoring-stack/dev/setup/repos.yaml';
    const releaseText = `apiVersion: helm.toolkit.fluxcd.io/v2beta2\nkind: HelmRelease\nmetadata:\n  name: prometheus-stack\nspec:\n  chart:\n    spec:\n      chart: kube-prometheus-stack\n      version: "86.1.1"\n      sourceRef:\n        kind: HelmRepository\n        name: prometheus-community\n  values:\n    resources:\n      requests:\n        cpu: 500m\n`;
    const repoText = `apiVersion: source.toolkit.fluxcd.io/v1beta2\nkind: HelmRepository\nmetadata:\n  name: prometheus-community\nspec:\n  url: https://prometheus-community.github.io/helm-charts\n`;
    const document = createTextDocument(releaseText, releasePath);

    vi.mocked(vscode.workspace.findFiles).mockImplementation(
      async (pattern) => {
        const normalized =
          typeof pattern === 'string' ? pattern : pattern.pattern;
        if (normalized === '*.yaml' || normalized === '*.yml') {
          return [vscode.Uri.file(repoPath), vscode.Uri.file(releasePath)];
        }
        if (normalized === '**/*.yaml' || normalized === '**/*.yml') {
          return [vscode.Uri.file(repoPath), vscode.Uri.file(releasePath)];
        }
        return [];
      },
    );
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(
      async (uri: { fsPath: string }) => {
        const text = uri.fsPath === repoPath ? repoText : releaseText;
        return Buffer.from(text, 'utf8');
      },
    );

    const resolved = await resolveChartForDocument(
      document as vscode.TextDocument,
      new vscode.Position(13, 8),
    );

    expect(resolved?.repoUrl).toBe(
      'https://prometheus-community.github.io/helm-charts',
    );
    expect(resolved?.chart).toBe('kube-prometheus-stack');
  });

  it('falls back to a namespace-less HelmRepository when the release namespace is implicit elsewhere', () => {
    const text = `apiVersion: helm.toolkit.fluxcd.io/v2beta2\nkind: HelmRelease\nmetadata:\n  name: alloy\n  namespace: monitoring\nspec:\n  chart:\n    spec:\n      chart: alloy\n      version: "1.2.1"\n      sourceRef:\n        kind: HelmRepository\n        name: grafana-charts\n  values:\n    controller:\n      type: daemonset\n`;
    const release = getHelmReleases(
      parseYamlDocuments(text, vscode.Uri.file('/workspace/releases.yaml')),
    )[0];
    const repos = [
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
        kind: 'HelmRepository',
        metadata: { name: 'grafana-charts' },
        spec: { url: 'https://grafana.github.io/helm-charts' },
        documentUri: vscode.Uri.file('/workspace/repos.yaml'),
      },
    ];

    const resolved = resolveChartFromResources(release, repos);

    expect(resolved?.repoUrl).toBe('https://grafana.github.io/helm-charts');
    expect(resolved?.chart).toBe('alloy');
  });

  it('falls back to a namespace-less HelmRepository when sourceRef.namespace is explicitly set', () => {
    const text = `apiVersion: helm.toolkit.fluxcd.io/v2beta1\nkind: HelmRelease\nmetadata:\n  name: kubernetes-event-exporter\n  namespace: monitoring\nspec:\n  chart:\n    spec:\n      chart: kubernetes-event-exporter\n      version: 3.6.3\n      sourceRef:\n        kind: HelmRepository\n        name: bitnami\n        namespace: monitoring\n  values:\n    global:\n      security: {}\n`;
    const release = getHelmReleases(
      parseYamlDocuments(text, vscode.Uri.file('/workspace/releases.yaml')),
    )[0];
    const repos = [
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1',
        kind: 'HelmRepository',
        metadata: { name: 'bitnami' },
        spec: { type: 'oci', url: 'oci://registry-1.docker.io/bitnamicharts' },
        documentUri: vscode.Uri.file('/workspace/repos.yaml'),
      },
    ];

    const resolved = resolveChartFromResources(release, repos);

    expect(resolved?.repoUrl).toBe('oci://registry-1.docker.io/bitnamicharts');
    expect(resolved?.chart).toBe('kubernetes-event-exporter');
  });

  it('resolves the correct HelmRelease when the cursor is on a later values line in a multi-document file', async () => {
    const text = `apiVersion: source.toolkit.fluxcd.io/v1beta2\nkind: HelmRepository\nmetadata:\n  name: repo\nspec:\n  url: https://charts.example.com\n---\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: first\nspec:\n  chart:\n    spec:\n      chart: base\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    enabled: true\n---\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: second\nspec:\n  chart:\n    spec:\n      chart: alloy\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    enabled: true\n`;
    const document = createTextDocument(text, '/workspace/releases.yaml');
    const valuesOffset = text.lastIndexOf('values:');
    const valuesPosition = document.positionAt(valuesOffset);

    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);

    const resolved = await resolveChartForDocument(
      document as vscode.TextDocument,
      valuesPosition,
    );

    expect(resolved?.chart).toBe('alloy');
  });
});
