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

## CI And Release Automation

This repository includes:

- `.github/workflows/pr-tests.yml` for pull request validation
- `.github/workflows/release.yml` for manual GitHub releases from `main`
- `release.config.cjs` for semantic-release

The release workflow:

1. runs on `workflow_dispatch`
2. only executes on the `main` branch
3. runs install, compile, and tests
4. uses semantic-release to determine the next version from commit messages
5. updates `CHANGELOG.md`
6. creates a GitHub release
7. uploads a packaged `.vsix` asset

The GitHub release workflow does not publish to the VS Code Marketplace. Publish Marketplace releases locally with `vsce publish` after validating the package.

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

For Marketplace releases, publish locally from a clean checkout after validating the package.

Log in once with a Marketplace token for the `oscarwest` publisher:

```bash
npx vsce login oscarwest
```

To let semantic-release choose and write the version first, run the release locally:

```bash
npm run release
```

Local semantic-release needs a GitHub token with permission to create releases for this repository. You can export one from the GitHub CLI session before running the release:

```bash
export GITHUB_TOKEN="$(gh auth token)"
```

This updates `package.json` and `package-lock.json`, writes `CHANGELOG.md`, creates the GitHub release, and packages a versioned VSIX such as `vscode-flux-helm-intellisense-1.0.0.vsix`.

Then publish that exact VSIX to the Marketplace:

```bash
npx vsce publish --packagePath vscode-flux-helm-intellisense-<version>.vsix
```

Replace `<version>` with the version semantic-release printed and wrote to `package.json`.

If you intentionally want to publish the already checked-in `package.json` version without running semantic-release, use `npx vsce publish`.

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

- verify conventional commits are ready for semantic-release
- run `npm install`
- run `npm run check`
- run `npm run compile`
- run `npm test`
- test in Extension Development Host
- run `npm run release`
- install the generated `.vsix` locally
- publish locally with `npx vsce publish --packagePath vscode-flux-helm-intellisense-<version>.vsix`
