import * as vscode from 'vscode';

export interface SourceRef {
  kind: string;
  name: string;
  namespace?: string;
}

export interface HelmRepositoryResource {
  apiVersion?: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
  spec: {
    url?: string;
    type?: string;
  };
  documentUri: vscode.Uri;
}

export interface HelmReleaseChartSpec {
  chart?: string;
  version?: string;
  sourceRef?: SourceRef;
}

export interface HelmReleaseResource {
  apiVersion?: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
  spec: {
    chart?: {
      spec?: HelmReleaseChartSpec;
    };
    values?: unknown;
  };
  documentUri: vscode.Uri;
}

export interface ParsedYamlDocument {
  uri: vscode.Uri;
  index: number;
  text: string;
  root: unknown;
  startOffset: number;
  endOffset: number;
}

export interface ValuesContext {
  release: HelmReleaseResource;
  valuesNode: import('yaml').Node | undefined;
  valuesKeyOffset: number;
  documentIndex: number;
}

export interface ResolvedChart {
  release: HelmReleaseResource;
  repository: HelmRepositoryResource;
  chart: string;
  version?: string;
  repoUrl: string;
  isOci: boolean;
}

export interface ChartMetadata {
  chartDir: string;
  valuesSchemaPath?: string;
  valuesPath?: string;
  fetchedAt: number;
  resolvedVersion?: string;
}

export interface ChartLoadFailure {
  message: string;
  failedAt: number;
}

export interface SchemaCompletion {
  key: string;
  path: string[];
  schema: JsonSchema;
}

export interface ValuesCompletion {
  key: string;
  path: string[];
  value: unknown;
  description?: string;
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  examples?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  definitions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
}
