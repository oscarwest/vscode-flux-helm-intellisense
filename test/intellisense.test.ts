import * as fs from 'fs/promises';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import { findValuesContext } from '../src/flux';
import {
  buildSchemaCompletionItems,
  buildValuesFallbackCompletionItems,
  provideSchemaDiagnostics,
  provideSchemaHover,
  provideValuesFallbackCompletions,
  provideValuesFallbackHover,
} from '../src/intellisense';
import type { JsonSchema } from '../src/types';
import { createTextDocument, positionOf } from './helpers';

function valuesContextFor(document: vscode.TextDocument, key = 'values') {
  const text = document.getText();
  const offset = text.indexOf(key);
  if (offset === -1) {
    throw new Error(`Missing context key: ${key}`);
  }
  const context = findValuesContext(document, document.positionAt(offset));
  if (!context) {
    throw new Error('Missing values context');
  }
  return context;
}

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

  it('offers child completions on the first blank line under an empty map key', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\n  namespace: apps\nspec:\n  chart:\n    spec:\n      chart: demo\n      sourceRef:\n        kind: HelmRepository\n        name: repo\n  values:\n    image:\n      \n    serviceIdentity:\n      team: platform\n`;
    const document = createTextDocument(helmRelease);
    const position = new vscode.Position(14, 6);

    const tempValuesPath =
      '/tmp/flux-helm-values-first-child-blankline-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      'affinity: {}\nimage:\n  repository: nginx\n  tag: latest\n  pullPolicy: IfNotPresent\nserviceIdentity:\n  team: platform\n',
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
    const labels = items.map((item) => item.label);

    expect(labels).toContain('repository');
    expect(labels).toContain('tag');
    expect(labels).toContain('pullPolicy');
    expect(labels).not.toContain('affinity');
    expect(labels).not.toContain('serviceIdentity');
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

  it('warns for unknown keys when schema forbids additional properties', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    database:\n      enabled: true\n    asdf: asdf\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempSchemaPath = '/tmp/flux-helm-values-strict-schema.json';
    await fs.writeFile(
      tempSchemaPath,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'object' },
        },
      }),
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesSchemaPath: tempSchemaPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("Unknown chart value key 'asdf'.");
    expect(diagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(diagnostics[0]?.range.start.line).toBe(8);
    expect(diagnostics[0]?.range.start.character).toBe(4);
    expect(diagnostics[0]?.range.end.character).toBe(8);
  });

  it('uses values.yaml as a best-effort fallback for unknown root keys', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    database:\n      enabled: true\n    asdf: asdf\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-root-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      'database:\n  enabled: false\nprovisionResources: false\n',
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Chart defaults do not contain value key 'asdf'. This may be unsupported or a typo.",
    ]);
  });

  it('uses values.yaml as a best-effort fallback for unknown nested keys', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    database:\n      enabled: true\n      typo: true\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-nested-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      'database:\n  enabled: false\n  host: localhost\n',
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("value key 'typo'");
    expect(diagnostics[0]?.range.start.line).toBe(8);
    expect(diagnostics[0]?.range.start.character).toBe(6);
  });

  it('lets strict schema diagnostics win over values.yaml fallback diagnostics', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    asdf: asdf\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempSchemaPath = '/tmp/flux-helm-values-lint-strict-wins-schema.json';
    const tempValuesPath = '/tmp/flux-helm-values-lint-strict-wins-values.yaml';
    await fs.writeFile(
      tempSchemaPath,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: {
          database: { type: 'object' },
        },
      }),
      'utf8',
    );
    await fs.writeFile(tempValuesPath, 'database: {}\n', 'utf8');

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesSchemaPath: tempSchemaPath,
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Unknown chart value key 'asdf'.",
    ]);
  });

  it('falls back to values.yaml when schema is permissive', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    asdf: asdf\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempSchemaPath = '/tmp/flux-helm-values-lint-permissive-schema.json';
    const tempValuesPath = '/tmp/flux-helm-values-lint-permissive-values.yaml';
    await fs.writeFile(
      tempSchemaPath,
      JSON.stringify({
        type: 'object',
        properties: {
          database: { type: 'object' },
        },
      }),
      'utf8',
    );
    await fs.writeFile(tempValuesPath, 'dynamic: true\n', 'utf8');

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesSchemaPath: tempSchemaPath,
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Chart defaults do not contain value key 'asdf'. This may be unsupported or a typo.",
    ]);
  });

  it('does not warn when neither schema nor matching defaults can evaluate a path', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    dynamic:\n      asdf: asdf\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-no-node-values.yaml';
    await fs.writeFile(tempValuesPath, 'dynamic: true\n', 'utf8');

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toEqual([]);
  });

  it('keeps diagnostics scoped to the selected HelmRelease document', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: first\nspec:\n  values:\n    asdf: first\n---\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: second\nspec:\n  values:\n    asdf: second\n`;
    const { document, position } = positionOf(helmRelease, 'asdf: second');
    const typedDocument = document as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-multidoc-values.yaml';
    await fs.writeFile(tempValuesPath, 'database: {}\n', 'utf8');
    const context = findValuesContext(typedDocument, position);
    if (!context) {
      throw new Error('Missing second document values context');
    }

    const diagnostics = await provideSchemaDiagnostics(
      typedDocument,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      context,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("value key 'asdf'");
    expect(diagnostics[0]?.range.start.line).toBe(14);
  });

  it('does not warn for known empty object or array values', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    resources: {}\n    tolerations: []\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-empty-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      'resources:\n  limits:\n    cpu: 100m\ntolerations:\n  - key: dedicated\n',
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toEqual([]);
  });

  it('does not warn for nested keys under null defaults because the path cannot be evaluated', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    resources:\n      limits:\n        cpu: 100m\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath =
      '/tmp/flux-helm-values-lint-null-default-values.yaml';
    await fs.writeFile(tempValuesPath, 'resources:\n', 'utf8');

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toEqual([]);
  });

  it('matches quoted keys against values.yaml defaults', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    "service.annotations": {}\n    "bad.annotation": true\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-quoted-values.yaml';
    await fs.writeFile(tempValuesPath, '"service.annotations": {}\n', 'utf8');

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Chart defaults do not contain value key 'bad.annotation'. This may be unsupported or a typo.",
    ]);
  });

  it('uses values.yaml array item shape for fallback linting across all indexes', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    extraEnv:\n      - name: FIRST\n        value: one\n      - name: SECOND\n        typo: two\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempValuesPath = '/tmp/flux-helm-values-lint-array-values.yaml';
    await fs.writeFile(
      tempValuesPath,
      'extraEnv:\n  - name: EXAMPLE\n    value: example\n',
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesPath: tempValuesPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("value key 'typo'");
  });

  it('does not warn for dynamic schema maps using additionalProperties schemas', async () => {
    const helmRelease = `apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: demo\nspec:\n  values:\n    labels:\n      app.kubernetes.io/name: demo\n`;
    const document = createTextDocument(helmRelease) as vscode.TextDocument;
    const tempSchemaPath = '/tmp/flux-helm-values-lint-dynamic-map-schema.json';
    await fs.writeFile(
      tempSchemaPath,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: {
          labels: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      }),
      'utf8',
    );

    const diagnostics = await provideSchemaDiagnostics(
      document,
      {
        chartDir: '/tmp/chart',
        valuesSchemaPath: tempSchemaPath,
        fetchedAt: Date.now(),
      },
      valuesContextFor(document),
    );

    expect(diagnostics).toEqual([]);
  });
});
