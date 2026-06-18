import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildSchemaCompletionItems,
  provideSchemaHover,
  buildValuesFallbackCompletionItems,
  provideValuesFallbackCompletions,
  provideValuesFallbackHover,
} from '../src/intellisense';
import type { JsonSchema } from '../src/types';
import { createTextDocument, positionOf } from './helpers';

describe('intellisense completion builders', () => {
  it('generates schema-backed completion items with snippets and docs', () => {
    const schema: Record<string, JsonSchema> = {
      image: {
        type: 'object',
        description: 'Container image settings',
        properties: {
          repository: { type: 'string' },
        },
      },
      replicaCount: {
        type: 'integer',
        default: 2,
        description: 'Desired replica count',
      },
    };

    const items = buildSchemaCompletionItems(schema, new Set(['image']));

    expect(items.map((item) => item.label)).toEqual(['replicaCount']);
    expect(items[0]?.insertText?.value).toBe('replicaCount: 2');
    expect(items[0]?.documentation?.value).toContain('Desired replica count');
    expect(items[0]?.documentation?.value).toContain('Default: 2');
  });

  it('uses YAML-shaped snippets for object completions instead of expanding large blobs', () => {
    const schema: Record<string, JsonSchema> = {
      _internal_defaults_do_not_set: {
        type: 'object',
      },
      serviceMonitor: {
        type: 'object',
        description: 'Service monitor configuration',
        properties: {
          enabled: { type: 'boolean' },
          interval: { type: 'string' },
        },
      },
    };

    const items = buildSchemaCompletionItems(schema, new Set());

    expect(items.map((item) => item.label)).not.toContain(
      '_internal_defaults_do_not_set',
    );
    expect(items[0]?.insertText?.value).toBe('serviceMonitor: \n  ${1}');
  });

  it('generates values.yaml fallback completion items from parsed defaults', () => {
    const valuesDoc = parseDocument(
      `# image block\nimage:\n  # image repo\n  repository: nginx\n# replicas to run\nreplicaCount: 3\n# service config\nservice:\n  port: 80\n`,
      {
        prettyErrors: false,
        strict: false,
        uniqueKeys: false,
      },
    );

    const items = buildValuesFallbackCompletionItems(
      valuesDoc.contents as any,
      new Set(['image']),
    );

    expect(items.map((item) => item.label)).toEqual([
      'replicaCount',
      'service',
    ]);
    expect(items[0]?.insertText?.value).toBe('replicaCount: 3');
    expect(items[0]?.documentation?.value).toContain('replicas to run');
    expect(items[1]?.insertText?.value).toBe('service: \n  ${1}');
    expect(items[1]?.documentation?.value).toContain('service config');
  });

  it('shows values.yaml comments in fallback hovers', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: demo\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    serviceMonitor:\n      enabled: true\n`;
    const { document, position } = positionOf(helmRelease, 'serviceMonitor');

    const tempValuesPath = '/tmp/flux-helm-values-hover-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      '# service monitor settings\nserviceMonitor:\n  enabled: true\n',
      'utf8',
    );

    const hover = await provideValuesFallbackHover(
      document as vscode.TextDocument,
      position,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
    );

    expect(hover?.contents.value).toContain('service monitor settings');
    expect(hover?.contents.value).toContain('Example:');
  });

  it('offers fallback completions while a key is partially typed', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: demo\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    se\n`;
    const document = createTextDocument(helmRelease);
    const position = new vscode.Position(13, 6);

    const tempValuesPath = '/tmp/flux-helm-values-completion-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      '# service settings\nserviceMonitor:\n  enabled: true\n# spegel settings\nspegel:\n  mirroredRegistries: []\n',
      'utf8',
    );

    const items = await provideValuesFallbackCompletions(
      document as vscode.TextDocument,
      position,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
    );

    expect(items.map((item) => item.label)).toContain('serviceMonitor');
    expect(items.map((item) => item.label)).toContain('spegel');
  });

  it('offers fallback completions on a blank line inside values', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: demo\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    \n    mirroredRegistries:\n      - https://docker.io\n`;
    const document = createTextDocument(helmRelease);
    const position = new vscode.Position(13, 4);

    const tempValuesPath = '/tmp/flux-helm-values-blankline-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      '# service settings\nserviceMonitor:\n  enabled: true\n# spegel settings\nspegel:\n  mirroredRegistries: []\n',
      'utf8',
    );

    const items = await provideValuesFallbackCompletions(
      document as vscode.TextDocument,
      position,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
    );

    expect(items.map((item) => item.label)).toContain('serviceMonitor');
    expect(items.map((item) => item.label)).toContain('spegel');
  });

  it('resolves fallback hovers against the correct HelmRelease in a multi-document file', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: first\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: first\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    replicaCount: 1\n---\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: second\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: second\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    serviceMonitor:\n      enabled: true\n`;
    const { document, position } = positionOf(helmRelease, 'serviceMonitor');

    const tempValuesPath = '/tmp/flux-helm-values-multidoc-hover-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      '# second release service monitor\nserviceMonitor:\n  enabled: true\n',
      'utf8',
    );

    const hover = await provideValuesFallbackHover(
      document as vscode.TextDocument,
      position,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
    );

    expect(hover?.contents.value).toContain('second release service monitor');
  });

  it('resolves schema hovers against the correct HelmRelease in a multi-document file', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: first\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: first\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    replicaCount: 1\n---\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: second\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: second\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    global:\n      enabled: true\n`;
    const { document, position } = positionOf(helmRelease, 'global');

    const tempSchemaPath = '/tmp/flux-helm-values-multidoc-hover-schema.json';
    await fs.writeFile(
      tempSchemaPath,
      JSON.stringify({
        type: 'object',
        properties: {
          global: {
            type: 'object',
            description: 'second release global settings',
          },
        },
      }),
      'utf8',
    );

    const hover = await provideSchemaHover(
      document as vscode.TextDocument,
      position,
      {
        chartDir: '/tmp/chart',
        valuesSchemaPath: tempSchemaPath,
        fetchedAt: Date.now(),
      },
    );

    expect(hover?.contents.value).toContain('second release global settings');
  });
});
