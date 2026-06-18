# Publishing

This document covers the minimum steps to package and publish `vscode-flux-helm-intellisense` to the VS Code Marketplace.

## Before You Publish

Confirm these basics first:

- `npm run compile` passes
- `npm test` passes
- the extension works in an Extension Development Host against a real Flux repo
- `publisher` in `package.json` matches the Marketplace publisher you control
- the extension description and command titles are accurate
- the README reflects the current feature set

## Marketplace Prerequisites

1. Create or use an existing Visual Studio Marketplace publisher.
2. Install the VS Code extension publishing tool.
3. Authenticate with a Personal Access Token for Marketplace publishing.

Typical install command:

```bash
npm install --save-dev @vscode/vsce
```

You can also install it globally if preferred.

## CI And Release Automation

This repository includes:

- `.github/workflows/pr-tests.yml` for pull request validation
- `.github/workflows/release.yml` for manual releases from `main`
- `release.config.cjs` for semantic-release

The release workflow:

1. runs on `workflow_dispatch`
2. only executes on the `main` branch
3. runs install, compile, and tests
4. uses semantic-release to determine the next version from commit messages
5. updates `CHANGELOG.md`
6. creates a GitHub release
7. uploads a packaged `.vsix` asset

Use conventional commits for reliable versioning, for example:

- `feat: add schema-backed hover docs`
- `fix: resolve sibling HelmRepository files`
- `chore: update release workflow`

## Package The Extension

From the repository root:

```bash
npx vsce package
```

That produces a `.vsix` file you can install locally or upload.

## Publish The Extension

For GitHub releases in this repository, prefer the manual release workflow instead of `vsce publish`.

Run semantic-release locally only if you intentionally want to reproduce the CI release flow:

```bash
npm run release
```

If you later decide to publish directly to the VS Code Marketplace, add the necessary Marketplace token flow separately.

## Local Validation Before Marketplace Publish

You can test the packaged extension locally:

```bash
code --install-extension ./vscode-flux-helm-intellisense-1.0.0.vsix
```

Then open a Flux repo and validate:

- CodeLens appears above `values:` blocks
- status bar resolves the active chart
- `Show Logs` exposes extension output
- `Open values.schema.json` and `Open values.yaml` work where available
- completion and hover work in single and multi-HelmRelease files

## Recommended Follow-Up Cleanup

Before a real public release, consider adding or reviewing:

- a `.gitignore`
- a `.vscodeignore`
- repository metadata in `package.json` such as `repository`, `homepage`, and `bugs`
- license choice instead of `UNLICENSED` if public distribution is intended
- an icon and Marketplace banner assets
- changelog or release notes process

## Suggested Release Checklist

- verify `package.json` version
- run `npm install`
- run `npm run compile`
- run `npm test`
- test in Extension Development Host
- package with `npx vsce package`
- install the generated `.vsix` locally
- run the manual GitHub Actions release workflow from `main`
