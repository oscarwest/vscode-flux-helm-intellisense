module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    [
      '@semantic-release/exec',
      {
        prepareCmd:
          'npm version ${nextRelease.version} --no-git-tag-version --allow-same-version && npm run compile && npx vsce package --out vscode-flux-helm-intellisense-${nextRelease.version}.vsix'
      }
    ],
    [
      '@semantic-release/github',
      {
        assets: [
          {
            path: 'vscode-flux-helm-intellisense-*.vsix',
            label: 'VSIX package'
          }
        ]
      }
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
      }
    ]
  ]
};
