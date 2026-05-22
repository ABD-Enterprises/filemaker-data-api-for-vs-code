# Installing FileMaker Data API Tools

Three ways to install the extension, in order of recommendation.

## 1. VS Code Marketplace (canonical)

This is the path 99% of users want.

1. Open the Extensions view in VS Code (`⌘+Shift+X` / `Ctrl+Shift+X`).
2. Search for **FileMaker Data API Tools**.
3. Click **Install**.

Or from the command line:

```bash
code --install-extension deffenda.filemaker-data-api-tools
```

Auto-updates land in VS Code on its normal extension-update cadence.

## 2. From a downloaded VSIX

Useful when you need a specific version, pre-release builds, or air-gapped install.

```bash
# Download the VSIX from the GitHub release of your choice:
curl -L -o filemaker-data-api-tools-1.1.0.vsix \
  https://github.com/deffenda/filemaker-data-api-for-vs-code/releases/download/v1.1.0/filemaker-data-api-tools-1.1.0.vsix

# Install:
code --install-extension filemaker-data-api-tools-1.1.0.vsix
```

VSIX files do NOT auto-update — you reinstall on every release. For most
users the Marketplace path is better.

## 3. Homebrew (Mac power users)

For people who manage all their tools via `brew`. This path is purely
convenience — there's nothing the brew formula does that
`code --install-extension` doesn't.

```bash
brew tap deffenda/tap
brew install filemaker-vscode
```

The formula downloads the VSIX from the GitHub release and installs it
via `code --install-extension`. See
[tools/homebrew/](../tools/homebrew/) for the formula template and
the release-time publishing script (`update-formula.sh`).

Updating:

```bash
brew upgrade filemaker-vscode
```

## Verifying the install

After install, verify in VS Code:

1. Open the Command Palette (`⌘+Shift+P` / `Ctrl+Shift+P`).
2. Type **FileMaker:** — you should see commands like **FileMaker: Add
   Connection Profile**.
3. Run **FileMaker: Open Getting Started Walkthrough** to see the
   onboarding walkthrough.

## Uninstalling

- **VS Code Marketplace** install: Extensions view → gear icon on the
  entry → **Uninstall**.
- **VSIX** install: same as above; the source doesn't matter.
- **Homebrew** install: `brew uninstall filemaker-vscode`, then run
  `code --uninstall-extension deffenda.filemaker-data-api-tools` (brew
  doesn't unwind the VS Code-side install on its own).

Profiles and saved queries are not removed by uninstall — see
[PRIVACY.md](../extension/SECURITY.md once #150 lands) for the data
lifecycle.

## Reporting an install bug

Open an issue at https://github.com/deffenda/filemaker-data-api-for-vs-code/issues
with the title prefixed `install:`. Include:

- Your install path (Marketplace / VSIX / brew)
- Your VS Code version (`code --version`)
- Your OS + version
- Full error message
