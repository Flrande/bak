# AGENTS.md

## Release Workflow

When a feature is finished and the user wants it shipped, use this end-to-end flow instead of stopping after code changes.

1. Land the feature work first.
   Keep `master` clean before starting the release pass.

2. Bump the monorepo release version everywhere that ships.
   Update the root [package.json](D:/projects/bak/package.json), [packages/cli/package.json](D:/projects/bak/packages/cli/package.json), [packages/extension/package.json](D:/projects/bak/packages/extension/package.json), and [packages/protocol/package.json](D:/projects/bak/packages/protocol/package.json).

3. Keep extension version metadata sourced from the package version.
   Do not hardcode the shipped extension version in the extension runtime or in `public/manifest.json`.
   Before publishing, verify that [packages/extension/dist/manifest.json](D:/projects/bak/packages/extension/dist/manifest.json) reports the same version as [packages/extension/package.json](D:/projects/bak/packages/extension/package.json).

4. Run the release gates in PowerShell 7.

```powershell
pnpm -w typecheck
pnpm -w lint
pnpm -w test:unit
pnpm -w test:e2e:critical
pnpm -w release:report
```

5. Publish the npm packages only after the gates pass.

```powershell
pnpm -w release:publish
```

6. Update the local machine to the just-published versions.

```powershell
npm install -g @flrande/bak-cli@<version> @flrande/bak-extension@<version>
```

7. Sync the local Codex skill after release.
   Copy [skills/bak-browser-control](D:/projects/bak/skills/bak-browser-control) into `$CODEX_HOME/skills/bak-browser-control` or the resolved local Codex skills directory.

8. Verify the local install after updating it.
   Confirm the global npm packages are on the expected version.
   Confirm `bak setup --json` points `extensionDistPath` at the expected local unpacked extension folder.
   Confirm the installed extension manifest version matches the release version.

```powershell
npm list -g @flrande/bak-cli @flrande/bak-extension --depth=0
bak setup --json
Get-Content -LiteralPath (Join-Path (npm root -g) '@flrande\bak-extension\dist\manifest.json')
```

9. Record the release in git.
   Commit the release-state files, push `master`, and push the matching `v<version>` tag.

10. Close the loop with the human user.
    Remind them that unpacked Chromium extensions still need a manual reload in `chrome://extensions` or `edge://extensions` after the files on disk change.
