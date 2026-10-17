# Step 5 — Generate typed code

Turn layout metadata into code you can use in your own project:

- **FileMaker: Generate Types for Layout** writes a TypeScript interface for one
  layout's fields. **Generate Types for All Layouts** does every layout at once.
- **FileMaker: Generate TypeScript Client** writes a small typed client for the
  Data API.
- **FileMaker: Generate Snippets for Layout** adds editor snippets for common
  find and get-record calls.

Files go to the folder set in `filemaker.typegen.outputDir`. Run
**FileMaker: Open Generated Types Folder** to jump there.

Regenerate after a schema change, and pair it with a schema snapshot diff to see
exactly which fields moved.
