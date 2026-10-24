# Step 5 — Generate typed code

Turn layout metadata into code you can use in your own project:

- **FileMaker: Generate Types for Layout** writes a TypeScript interface for one
  layout's fields. **Generate Types for All Layouts** does every layout at once.
- **FileMaker: Generate TypeScript Client** writes a small typed client for the
  Data API.
- **FileMaker: Generate Snippets for Layout** adds editor snippets for common
  find and get-record calls.

Where the files go:

- Layout types: `layouts/<name>.ts` inside the folder set in
  `filemaker.typegen.outputDir` (default `filemaker-types`). Run
  **FileMaker: Open Generated Types Folder** to jump there. A layout name with
  spaces or punctuation gets a short hash in its file name.
- The typed client: the folder you choose when you run the command
  (`types.ts`, `client.ts` and a `README.md`).
- Snippets: `snippets/filemaker-data-api.code-snippets` in your workspace.

Generating files needs a trusted workspace. Before replacing an unrelated file, choose **Overwrite**, **Skip existing**, or **Cancel**. A linked output folder is refused with an explanation; a workspace opened through a symbolic link is allowed.

Regenerate after a schema change, and pair it with a schema snapshot diff to see
exactly which fields moved.
