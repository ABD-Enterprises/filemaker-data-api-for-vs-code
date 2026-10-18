# Release smoke test

A short manual pass to run on the build you are about to release (and again on the published version). It takes about 20 minutes. The release checklist in [docs/RELEASE.md](../../../docs/RELEASE.md) links here; record the result in the release pull request or in an issue made from the **QA: Smoke test** template.

## Set up

1. Use a clean VS Code profile so other extensions and settings do not interfere:
   ```bash
   code --user-data-dir /tmp/fm-smoke-user --extensions-dir /tmp/fm-smoke-ext
   ```
2. Install the build: `code --user-data-dir /tmp/fm-smoke-user --extensions-dir /tmp/fm-smoke-ext --install-extension artifacts/filemaker-data-api-tools-X.Y.Z.vsix` (or install from the Marketplace for the post-publish pass).
3. Pick a server:
   - **A real FileMaker Server** (HTTPS, an account with the `fmrest` extended privilege), or
   - **The mock Data API**: `npm run mock:server -w extension`, then use server `http://127.0.0.1:18080`, database `Sales`, account `tester`, password `testpass1`. Layouts are `Contacts` and `Invoices`. The mock approximates FileMaker; it does not prove behavior against a real server. Say which you used in the result.
4. Open an empty folder in VS Code and trust it.

## Checks

Tick each one. A failure in checks 1 to 12 blocks the release.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Install | The extension shows as `FileMaker Data API Tools`, version X.Y.Z, publisher SureForgeTech. The FileMaker icon is in the activity bar. |
| 2 | First run | The Getting Started walkthrough opens once, and its screenshots load. With no profile, the Connections view shows the welcome text with **Add Connection Profile**. |
| 3 | Command Palette | With no profile, typing `FileMaker:` lists only a short list of commands (for example add profile, getting started, user guide, diagnostics), not the data commands. |
| 4 | Wizard failure | **Add Connection Profile**, enter a bogus server, **Test Connection**: a red badge with a readable error. |
| 5 | Wizard success | Enter the real details, **Test Connection**: green. **Save Profile**, then **Connect Now** connects. The status bar shows `FileMaker: <profile>`. |
| 6 | Secrets | After saving, the password is not in `settings.json` or the Output channel. **Edit Connection Profile**, change the server address, **Save Profile**: the wizard asks for the password again. |
| 7 | Explorer | The profile expands to layouts, then Fields and Value Lists. |
| 8 | Query Builder | Open it on a layout, build a find with the form, **Run**. Results show with a found count. Paging, column sort and **Export > Save results as CSV…** work. A find that matches nothing shows an empty result, not an error. |
| 9 | Record Editor | Open a record, change a field, **Save**, confirm: the change appears. Then open the same record in two editors, save in one, and save in the other: the second save is refused and its form keeps the edit. |
| 10 | Batch | **Batch Export (Find)** to a `.csv` file works. **Batch Update from CSV/JSON** with **Dry-run only** shows a preview and changes nothing. |
| 11 | Schema | **Capture Schema Snapshot** twice, then **Diff Schema Snapshots** opens the diff. |
| 12 | Session | **Disconnect** changes the status bar and **Connect** works again. After the session is dropped (mock: `curl -X POST http://127.0.0.1:18080/__admin/expire`) the next find still succeeds. |
| 13 | Generated files | **Generate Types for Layout** writes a file under `filemaker-types/layouts/`. |
| 14 | Reload | **Developer: Reload Window**: the status bar item and the Connections view come back. |
| 15 | Untrusted workspace | In Restricted Mode, finds work; **Delete Record** and type generation are refused with a clear message. |
| 16 | Prompts | A file in `.vscode/filemaker-plugins/` asks before it runs. **Start FM Web Preview Server** (after **Initialize FM Web Project**) asks before running `npm` when run from the repository; in a Marketplace build it reports that the preview is not available in this installation. |
| 17 | AI default | The status bar shows `AI: off`. **Write AI Context** writes a file and offers to open it. With `filemaker.ai.enabled` off, no `fm_` tools are offered to the agent. |
| 18 | User guide | **FileMaker: Open User Guide** opens the guide. |
| 19 | Uninstall | Uninstalling removes the activity bar icon and the status bar items. |

## Result

Record the version, date, tester, VS Code version, operating system, real server or mock, pass or fail for each check, and links to any issues opened.

For a failure, open an issue titled `X.Y.Z QA: check N <short description>` with the redacted log (**View > Output > FileMaker Data API Tools**) or the **FileMaker: Show Diagnostics** report.
