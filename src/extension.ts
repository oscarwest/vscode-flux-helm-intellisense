import * as vscode from 'vscode';
import {
  findAllValuesContexts,
  invalidateWorkspaceRepositoryCache,
  resolveChartForDocument,
} from './flux';
import {
  buildHelmPullInvocation,
  ChartCache,
  checkHelmExecutable,
  formatHelmInvocationForShell,
} from './helm';
import {
  provideSchemaCompletions,
  provideSchemaDiagnostics,
  provideSchemaHover,
  provideValuesFallbackCompletions,
  provideValuesFallbackHover,
} from './intellisense';

const YAML_SELECTOR: vscode.DocumentSelector = [
  { language: 'yaml', scheme: 'file' },
  { language: 'yaml', scheme: 'untitled' },
];

type LoadedMetadata = NonNullable<
  Awaited<ReturnType<FluxHelmValuesService['getMetadata']>>
>;

interface FluxHelmCodeLens extends vscode.CodeLens {
  documentUri: vscode.Uri;
  position: vscode.Position;
  lensKind: 'summary' | 'openSchema' | 'openValues' | 'copyHelm';
}

function shortenSource(repoUrl: string): string {
  return repoUrl.replace(/^oci:\/\//, '').replace(/^https?:\/\//, '');
}

function buildStatusTooltip(loaded: LoadedMetadata): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**Chart**: ${loaded.resolved.chart}\n\n`);
  tooltip.appendMarkdown(
    `**Requested version**: ${loaded.resolved.version ?? 'latest compatible'}\n\n`,
  );
  tooltip.appendMarkdown(
    `**Resolved version**: ${loaded.metadata.resolvedVersion ?? 'unknown'}\n\n`,
  );
  tooltip.appendMarkdown(
    `**Source**: ${loaded.resolved.repository.kind}/${loaded.resolved.repository.metadata.name}\n\n`,
  );
  tooltip.appendMarkdown(`**Repository URL**: ${loaded.resolved.repoUrl}\n\n`);
  tooltip.appendMarkdown(`**Cache**: ${loaded.metadata.chartDir}`);
  return tooltip;
}

function getMetadataModeLabel(loaded: LoadedMetadata): string {
  if (loaded.metadata.valuesSchemaPath) {
    return 'schema';
  }
  if (loaded.metadata.valuesPath) {
    return 'values';
  }
  return 'chart';
}

function buildCodeLensTitle(loaded: LoadedMetadata): string {
  const version =
    loaded.metadata.resolvedVersion ?? loaded.resolved.version ?? 'unknown';
  const source =
    loaded.resolved.repository.metadata.name ||
    shortenSource(loaded.resolved.repoUrl);
  const mode = getMetadataModeLabel(loaded);
  return `$(package) ${loaded.resolved.chart} ${version} • ${source} • ${mode}`;
}

function buildHelmCommandText(
  loaded: LoadedMetadata,
  helmPath: string,
): string {
  const invocation = buildHelmPullInvocation(
    helmPath,
    loaded.resolved,
    loaded.metadata.chartDir,
  );
  return formatHelmInvocationForShell(invocation);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

async function openDocumentAt(
  uri: vscode.Uri,
): Promise<vscode.TextDocument | undefined> {
  const visible = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  if (visible) {
    return visible;
  }
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

class FluxHelmValuesService {
  private readonly warmInFlight = new Map<string, Promise<void>>();
  private helmCheckPromise: Promise<string> | undefined;
  private checkedHelmPath: string | undefined;
  private hasWarnedAboutHelm = false;

  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly chartCache: ChartCache,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async getMetadata(
    document: vscode.TextDocument,
    position?: vscode.Position,
    force = false,
  ) {
    const startedAt = Date.now();
    const resolved = await resolveChartForDocument(document, position);
    if (!resolved) {
      this.output.appendLine(
        `[resolve] No chart resolved for ${document.uri.fsPath}`,
      );
      return undefined;
    }
    await this.ensureHelmSetup();
    this.output.appendLine(
      `[resolve] ${resolved.chart} from ${resolved.repoUrl} (${force ? 'force' : 'cached'})`,
    );
    const metadata = await this.chartCache.load(resolved, force);
    this.output.appendLine(
      `[cache] Loaded ${resolved.chart} in ${Date.now() - startedAt}ms from ${metadata.chartDir}`,
    );
    return { resolved, metadata };
  }

  public async refreshDiagnostics(
    document: vscode.TextDocument,
  ): Promise<void> {
    const contexts = findAllValuesContexts(document);
    if (contexts.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    try {
      const allDiagnostics: vscode.Diagnostic[] = [];
      for (const context of contexts) {
        const loaded = await this.getMetadata(
          document,
          document.positionAt(context.valuesNode?.range?.[0] ?? 0),
        );
        if (!loaded) {
          continue;
        }
        allDiagnostics.push(
          ...(await provideSchemaDiagnostics(
            document,
            loaded.metadata,
            context,
          )),
        );
      }
      this.diagnostics.set(document.uri, allDiagnostics);
      this.output.appendLine(
        `[diagnostics] ${document.uri.fsPath} -> ${allDiagnostics.length} diagnostics`,
      );
    } catch (error) {
      this.output.appendLine(
        `[diagnostics] Failed for ${document.uri.fsPath}: ${formatErrorMessage(error)}`,
      );
      this.diagnostics.delete(document.uri);
    }
  }

  public warmDocument(
    document: vscode.TextDocument,
    force = false,
  ): Promise<void> {
    if (document.languageId !== 'yaml') {
      return Promise.resolve();
    }

    const key = `${document.uri.toString()}:${force ? 'force' : 'warm'}`;
    const existing = this.warmInFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const contexts = findAllValuesContexts(document);
      this.output.appendLine(
        `[warm] ${document.uri.fsPath} -> ${contexts.length} values block(s)`,
      );
      for (const context of contexts) {
        try {
          await this.getMetadata(
            document,
            document.positionAt(context.valuesNode?.range?.[0] ?? 0),
            force,
          );
        } catch (error) {
          this.output.appendLine(
            `[warm] Failed for ${document.uri.fsPath}: ${formatErrorMessage(error)}`,
          );
        }
      }
    })().finally(() => {
      this.warmInFlight.delete(key);
    });

    this.warmInFlight.set(key, pending);
    return pending;
  }

  public async ensureHelmSetup(showSuccess = false): Promise<string> {
    const helmPath = vscode.workspace
      .getConfiguration('fluxHelmValues')
      .get<string>('helmPath', 'helm');
    if (!this.helmCheckPromise || this.checkedHelmPath !== helmPath) {
      this.checkedHelmPath = helmPath;
      this.hasWarnedAboutHelm = false;
      this.helmCheckPromise = checkHelmExecutable(helmPath).catch((error) => {
        this.helmCheckPromise = undefined;
        throw error;
      });
    }

    try {
      const version = await this.helmCheckPromise;
      if (showSuccess) {
        void vscode.window.showInformationMessage(
          `Helm setup OK: ${helmPath} (${version})`,
        );
      }
      return version;
    } catch (error) {
      if (!this.hasWarnedAboutHelm) {
        this.hasWarnedAboutHelm = true;
        void vscode.window.showWarningMessage(
          error instanceof Error ? error.message : 'Helm setup check failed.',
        );
      }
      throw error;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Flux Helm Values');
  output.appendLine('[activate] Flux Helm Values activated');
  const statusBar = vscode.window.createStatusBarItem(
    'fluxHelmValues.status',
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.name = 'Flux Helm Values';
  statusBar.command = 'fluxHelmValues.showResolvedChart';
  const diagnostics =
    vscode.languages.createDiagnosticCollection('fluxHelmValues');
  const chartCache = new ChartCache(context);
  const service = new FluxHelmValuesService(diagnostics, chartCache, output);
  let statusRequestId = 0;

  const updateStatusBar = async (editor?: vscode.TextEditor): Promise<void> => {
    const currentRequestId = ++statusRequestId;
    if (editor?.document.languageId !== 'yaml') {
      statusBar.hide();
      return;
    }

    if (findAllValuesContexts(editor.document).length === 0) {
      statusBar.hide();
      return;
    }

    statusBar.text = '$(sync~spin) Flux Helm Values';
    statusBar.tooltip = 'Resolving Helm chart metadata...';
    statusBar.show();

    try {
      const loaded = await service.getMetadata(
        editor.document,
        editor.selection.active,
      );
      if (currentRequestId !== statusRequestId) {
        return;
      }
      if (!loaded) {
        statusBar.hide();
        return;
      }

      const version =
        loaded.metadata.resolvedVersion ?? loaded.resolved.version ?? 'unknown';
      const source =
        loaded.resolved.repository.metadata.name ||
        shortenSource(loaded.resolved.repoUrl);
      statusBar.text = `$(package) ${loaded.resolved.chart} ${version} • ${source}`;
      statusBar.tooltip = buildStatusTooltip(loaded);
      statusBar.show();
    } catch (error) {
      if (currentRequestId !== statusRequestId) {
        return;
      }
      statusBar.text = '$(warning) Flux Helm Values';
      statusBar.tooltip =
        error instanceof Error
          ? error.message
          : 'Failed to resolve Helm chart metadata.';
      statusBar.command = 'fluxHelmValues.showLogs';
      statusBar.show();
    } finally {
      if (
        currentRequestId === statusRequestId &&
        statusBar.command !== 'fluxHelmValues.showLogs'
      ) {
        statusBar.command = 'fluxHelmValues.showResolvedChart';
      }
    }
  };

  context.subscriptions.push(
    output,
    statusBar,
    diagnostics,
    vscode.languages.registerCodeLensProvider(YAML_SELECTOR, {
      provideCodeLenses(document) {
        return findAllValuesContexts(document).flatMap((context) => {
          const line = document.positionAt(context.valuesKeyOffset).line;
          const range = new vscode.Range(line, 0, line, 0);
          const position = document.positionAt(context.valuesKeyOffset);
          const makeLens = (lensKind: FluxHelmCodeLens['lensKind']) => {
            const lens = new vscode.CodeLens(range) as FluxHelmCodeLens;
            lens.documentUri = document.uri;
            lens.position = position;
            lens.lensKind = lensKind;
            return lens;
          };
          return [
            makeLens('copyHelm'),
            makeLens('summary'),
            makeLens('openSchema'),
            makeLens('openValues'),
          ];
        });
      },
      async resolveCodeLens(codeLens) {
        const lens = codeLens as FluxHelmCodeLens;
        const document = await openDocumentAt(lens.documentUri);
        if (!document) {
          codeLens.command = {
            title: '$(warning) Flux Helm Values unavailable',
            command: 'fluxHelmValues.showLogs',
          };
          return codeLens;
        }

        try {
          const loaded = await service.getMetadata(document, lens.position);
          if (!loaded) {
            codeLens.command = {
              title: '$(warning) Flux Helm Values unresolved',
              command: 'fluxHelmValues.showLogs',
            };
            return codeLens;
          }

          if (lens.lensKind === 'summary') {
            codeLens.command = {
              title: buildCodeLensTitle(loaded),
              command: 'fluxHelmValues.showResolvedChartAt',
              arguments: [lens.documentUri, lens.position],
            };
            return codeLens;
          }

          if (lens.lensKind === 'openSchema') {
            codeLens.command = loaded.metadata.valuesSchemaPath
              ? {
                  title: 'Open values.schema.json',
                  command: 'fluxHelmValues.openResolvedFile',
                  arguments: [loaded.metadata.valuesSchemaPath],
                }
              : {
                  title: 'No schema file',
                  command: 'fluxHelmValues.showLogs',
                };
            return codeLens;
          }

          if (lens.lensKind === 'openValues') {
            codeLens.command = loaded.metadata.valuesPath
              ? {
                  title: 'Open values.yaml',
                  command: 'fluxHelmValues.openResolvedFile',
                  arguments: [loaded.metadata.valuesPath],
                }
              : {
                  title: 'No values file',
                  command: 'fluxHelmValues.showLogs',
                };
            return codeLens;
          }

          codeLens.command = {
            title: '$(copy) Copy helm pull',
            command: 'fluxHelmValues.copyHelmCommandAt',
            arguments: [lens.documentUri, lens.position],
          };
          return codeLens;
        } catch (error) {
          output.appendLine(
            `[codelens] Failed for ${document.uri.fsPath}: ${formatErrorMessage(error)}`,
          );
          codeLens.command = {
            title: `$(warning) ${error instanceof Error ? error.message : 'Flux Helm Values failed'}`,
            command: 'fluxHelmValues.showLogs',
          };
          return codeLens;
        }
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      YAML_SELECTOR,
      {
        async provideCompletionItems(document, position) {
          output.appendLine(
            `[completion] Request at ${document.uri.fsPath}:${position.line + 1}:${position.character + 1}`,
          );
          const loaded = await service.getMetadata(document, position);
          if (!loaded) {
            return [];
          }

          const schemaItems = await provideSchemaCompletions(
            document,
            position,
            loaded.metadata,
          );
          if (schemaItems.length > 0) {
            return schemaItems;
          }
          return provideValuesFallbackCompletions(
            document,
            position,
            loaded.metadata,
          );
        },
      },
      ':',
      '\n',
    ),
    vscode.languages.registerHoverProvider(YAML_SELECTOR, {
      async provideHover(document, position) {
        output.appendLine(
          `[hover] Request at ${document.uri.fsPath}:${position.line + 1}:${position.character + 1}`,
        );
        const loaded = await service.getMetadata(document, position);
        if (!loaded) {
          return undefined;
        }
        return (
          (await provideSchemaHover(document, position, loaded.metadata)) ??
          provideValuesFallbackHover(document, position, loaded.metadata)
        );
      },
    }),
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (document.languageId === 'yaml') {
        output.appendLine(`[document] Opened ${document.uri.fsPath}`);
        await service.warmDocument(document);
        await service.refreshDiagnostics(document);
        if (
          vscode.window.activeTextEditor?.document.uri.toString() ===
          document.uri.toString()
        ) {
          await updateStatusBar(vscode.window.activeTextEditor);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.document.languageId === 'yaml') {
        output.appendLine(`[document] Changed ${event.document.uri.fsPath}`);
        await service.warmDocument(event.document);
        await service.refreshDiagnostics(event.document);
        if (
          vscode.window.activeTextEditor?.document.uri.toString() ===
          event.document.uri.toString()
        ) {
          await updateStatusBar(vscode.window.activeTextEditor);
        }
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.languageId === 'yaml') {
        output.appendLine(`[document] Active ${editor.document.uri.fsPath}`);
        await service.warmDocument(editor.document);
        await service.refreshDiagnostics(editor.document);
        await updateStatusBar(editor);
        return;
      }
      await updateStatusBar(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        await updateStatusBar(event.textEditor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'yaml') {
        invalidateWorkspaceRepositoryCache();
        output.appendLine(
          `[repository-index] Invalidated after save: ${document.uri.fsPath}`,
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('fluxHelmValues.repositorySearchPaths')) {
        invalidateWorkspaceRepositoryCache();
        output.appendLine(
          '[repository-index] Invalidated after repositorySearchPaths change',
        );
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      invalidateWorkspaceRepositoryCache();
      output.appendLine(
        `[repository-index] Invalidated after create: ${event.files.length} file(s)`,
      );
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      invalidateWorkspaceRepositoryCache();
      output.appendLine(
        `[repository-index] Invalidated after delete: ${event.files.length} file(s)`,
      );
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
    }),
    vscode.commands.registerCommand(
      'fluxHelmValues.refreshChartCache',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage(
            'Open a HelmRelease YAML document first.',
          );
          return;
        }
        try {
          const loaded = await service.getMetadata(
            editor.document,
            editor.selection.active,
            true,
          );
          if (!loaded) {
            void vscode.window.showWarningMessage(
              'No Flux HelmRelease chart could be resolved from the active document.',
            );
            return;
          }
          await chartCache.refresh(loaded.resolved, true);
          await service.refreshDiagnostics(editor.document);
          await updateStatusBar(editor);
          void vscode.window.showInformationMessage(
            `Refreshed chart cache for ${loaded.resolved.chart}.`,
          );
        } catch (error) {
          output.appendLine(
            `[command] refreshChartCache failed: ${formatErrorMessage(error)}`,
          );
          void vscode.window.showErrorMessage(
            error instanceof Error
              ? error.message
              : 'Failed to refresh chart cache.',
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.clearChartCache',
      async () => {
        await chartCache.clear();
        diagnostics.clear();
        output.appendLine('[command] Chart cache cleared');
        await updateStatusBar(vscode.window.activeTextEditor);
        void vscode.window.showInformationMessage(
          'Flux Helm Values chart cache cleared.',
        );
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.showResolvedChart',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage(
            'Open a HelmRelease YAML document first.',
          );
          return;
        }
        const loaded = await service.getMetadata(
          editor.document,
          editor.selection.active,
        );
        if (!loaded) {
          void vscode.window.showWarningMessage(
            'No Flux HelmRelease chart could be resolved from the active document.',
          );
          return;
        }
        const lines = [
          `Repository: ${loaded.resolved.repoUrl}`,
          `Chart: ${loaded.resolved.chart}`,
          `Requested version: ${loaded.resolved.version ?? 'latest compatible'}`,
          `Resolved version: ${loaded.metadata.resolvedVersion ?? 'unknown'}`,
          `Cache: ${loaded.metadata.chartDir}`,
        ];
        output.appendLine(`[command] ${lines.join(' | ')}`);
        const copy = 'Copy Helm Pull';
        const selected = await vscode.window.showInformationMessage(
          lines.join(' | '),
          copy,
        );
        if (selected === copy) {
          await vscode.commands.executeCommand(
            'fluxHelmValues.copyHelmCommand',
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.showResolvedChartAt',
      async (uri: vscode.Uri, position: vscode.Position) => {
        const document = await openDocumentAt(uri);
        if (!document) {
          void vscode.window.showWarningMessage(
            'Unable to open the HelmRelease document.',
          );
          return;
        }
        const loaded = await service.getMetadata(document, position);
        if (!loaded) {
          void vscode.window.showWarningMessage(
            'No Flux HelmRelease chart could be resolved from that values block.',
          );
          return;
        }
        const lines = [
          `Repository: ${loaded.resolved.repoUrl}`,
          `Chart: ${loaded.resolved.chart}`,
          `Requested version: ${loaded.resolved.version ?? 'latest compatible'}`,
          `Resolved version: ${loaded.metadata.resolvedVersion ?? 'unknown'}`,
          `Source mode: ${getMetadataModeLabel(loaded)}`,
          `Cache: ${loaded.metadata.chartDir}`,
        ];
        output.appendLine(`[command] ${lines.join(' | ')}`);
        const copy = 'Copy Helm Pull';
        const selected = await vscode.window.showInformationMessage(
          lines.join(' | '),
          copy,
        );
        if (selected === copy) {
          await vscode.commands.executeCommand(
            'fluxHelmValues.copyHelmCommandAt',
            uri,
            position,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.openResolvedFile',
      async (targetPath: string) => {
        const targetUri = vscode.Uri.file(targetPath);
        const document = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(document, { preview: false });
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.copyHelmCommand',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage(
            'Open a HelmRelease YAML document first.',
          );
          return;
        }
        await vscode.commands.executeCommand(
          'fluxHelmValues.copyHelmCommandAt',
          editor.document.uri,
          editor.selection.active,
        );
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.copyHelmCommandAt',
      async (uri: vscode.Uri, position: vscode.Position) => {
        const document = await openDocumentAt(uri);
        if (!document) {
          void vscode.window.showWarningMessage(
            'Unable to open the HelmRelease document.',
          );
          return;
        }
        const loaded = await service.getMetadata(document, position);
        if (!loaded) {
          void vscode.window.showWarningMessage(
            'No Flux HelmRelease chart could be resolved from that values block.',
          );
          return;
        }
        const helmPath = vscode.workspace
          .getConfiguration('fluxHelmValues')
          .get<string>('helmPath', 'helm');
        const commandText = buildHelmCommandText(loaded, helmPath);
        await vscode.env.clipboard.writeText(commandText);
        output.appendLine(
          `[command] Copied helm pull command for ${loaded.resolved.chart}: ${commandText}`,
        );
        void vscode.window.showInformationMessage(
          `Copied helm pull command for ${loaded.resolved.chart}.`,
        );
      },
    ),
    vscode.commands.registerCommand(
      'fluxHelmValues.checkHelmSetup',
      async () => {
        try {
          const version = await service.ensureHelmSetup(true);
          output.appendLine(`[command] Helm setup OK: ${version}`);
        } catch (error) {
          output.appendLine(
            `[command] checkHelmSetup failed: ${formatErrorMessage(error)}`,
          );
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : 'Helm setup check failed.',
          );
        }
      },
    ),
    vscode.commands.registerCommand('fluxHelmValues.showLogs', async () => {
      output.show(true);
    }),
  );

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === 'yaml') {
      void service.warmDocument(document);
      void service.refreshDiagnostics(document);
    }
  }

  void updateStatusBar(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // No-op.
}
