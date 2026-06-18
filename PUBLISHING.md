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
- Marketplace screenshots and icon assets are committed, if you want them on the listing

## Marketplace Prerequisites

1. Create or use an existing Visual Studio Marketplace publisher.
2. Install the VS Code extension publishing tool.
3. Authenticate with a Personal Access Token for Marketplace publishing.

Typical install command:

```bash
npm install --save-dev @vscode/vsce
```

You can also install it globally if preferred.

## CI

This repository includes:

- `.github/workflows/pr-tests.yml` for pull request validation

Marketplace publishing is intentionally local for now.

## Package The Extension

From the repository root:

```bash
npx vsce package
```

That produces a `.vsix` file you can install locally or upload.

## Publish The Extension

For Marketplace releases, publish locally from a clean checkout after validating the package.

Log in once with a Marketplace token for the `westtechnologyconsultingab` publisher:

```bash
npx vsce login westtechnologyconsultingab
```

For a new release, update the version in `package.json` and `package-lock.json` without creating an npm tag:

```bash
npm version <version> --no-git-tag-version
```

Then package and publish that exact version:

```bash
npm run package:vsix
npx vsce publish --packagePath vscode-flux-helm-intellisense-<version>.vsix
```

If you want a matching GitHub tag after publishing, create it explicitly:

```bash
git tag v<version>
git push origin main v<version>
```

## Marketplace Page Assets

The Marketplace page is rendered primarily from `README.md` and `package.json`.

Recommended assets before publishing:

- screenshot in `assets/intellisense.jpg`, referenced from the README
- extension icon in `assets/icon.png`, referenced from `package.json` with `"icon": "assets/icon.png"`
- `galleryBanner` in `package.json` for the Marketplace header color

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

- an icon and Marketplace banner assets
- changelog or release notes process

## Suggested Release Checklist

- verify `package.json` version
- run `npm install`
- run `npm run check`
- run `npm run compile`
- run `npm test`
- test in Extension Development Host
- package with `npm run package:vsix`
- install the generated `.vsix` locally
- publish locally with `npx vsce publish --packagePath vscode-flux-helm-intellisense-<version>.vsix`
