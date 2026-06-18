# Manual Smoke Test

## Prerequisites

- `helm` is installed locally and available on `PATH`, or set `fluxHelmValues.helmPath` to the absolute executable path.
- You have a Flux repository open in VS Code with `HelmRelease` and `HelmRepository` YAML files.
- Run `npm install` and `npm run compile` in this extension repository.

## Launch The Extension

1. Open this repository in VS Code.
2. Press `F5` to start an Extension Development Host.
3. In the Extension Development Host, open a Flux workspace that contains Helm releases and repositories.

## Suggested Fixtures

Use any of these Flux files or equivalent local copies:

- `infrastructure/spegel/spegel.yaml`
- `infrastructure/base/controllers/cert-manager.yaml`
- `infrastructure/timescaledb/dev/operator/releases.yaml`
- `infrastructure/monitoring-stack/dev/setup/releases.yaml`

## Verify Resolution

1. Open a YAML file containing a Flux `HelmRelease`.
2. Confirm the file also contains a matching `HelmRepository`, or that one exists elsewhere in the workspace.
3. Place the cursor inside `spec.values`.
4. Run `Flux Helm Values: Show Resolved Chart` from the Command Palette.
5. Confirm the message shows the expected repository URL, chart name, requested version, and cache directory.

## Verify Schema-Backed IntelliSense

1. Pick a chart that ships `values.schema.json`.
2. Place the cursor on a new line inside `spec.values`.
3. Trigger completion with `Ctrl+Space`.
4. Confirm keys are suggested only for the current values object.
5. Confirm object and array insertions produce YAML-shaped snippets.
6. Hover an existing key.
7. Confirm the hover shows schema description, defaults, or allowed enum values when present.

## Verify values.yaml Fallback

1. Pick a chart that does not ship `values.schema.json` but does ship `values.yaml`.
2. Clear the chart cache with `Flux Helm Values: Clear Chart Cache`.
3. Reopen the `HelmRelease` file or run `Flux Helm Values: Refresh Chart Cache`.
4. Trigger completion inside `spec.values`.
5. Confirm key suggestions still appear.
6. Hover a known key.
7. Confirm the hover shows an example value derived from `values.yaml`.
8. Confirm unknown-key diagnostics are not shown in fallback mode.

## Verify Unknown-Key Diagnostics

1. Use a schema-backed chart.
2. Add a clearly invalid key under `spec.values`, such as `notARealChartKey: true`.
3. Confirm a warning diagnostic appears on that key.
4. Remove the invalid key and confirm the warning clears.

## Verify Cache Commands

1. Run `Flux Helm Values: Refresh Chart Cache` on an open `HelmRelease`.
2. Confirm the command succeeds and subsequent completions remain available.
3. Run `Flux Helm Values: Clear Chart Cache`.
4. Trigger completion again inside `spec.values`.
5. Confirm the extension repulls chart metadata and resumes suggestions.

## Failure Checks

1. Set `fluxHelmValues.helmPath` to a non-existent executable.
2. Run `Flux Helm Values: Refresh Chart Cache`.
3. Confirm an error message is shown.
4. Restore the correct Helm path and rerun the refresh command.
5. Confirm normal behavior returns.
