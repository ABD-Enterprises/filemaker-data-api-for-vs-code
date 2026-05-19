# Step 3 — Run your first query

![Query Builder webview with JSON editor, field-name chips, results table](../marketplace/query-builder.png)

With an active connection, you've got two paths:

## Quick: list layouts and pick a record

Run **FileMaker: List Layouts** to see every layout exposed via the Data
API. Right-click a layout in the sidebar to get common actions:
**Open Query Builder**, **Get Record by ID**, **Open Layout Metadata**,
**Generate Types for Layout**, **Batch Export (Find)**.

## Powerful: the Query Builder

Run **FileMaker: Open Query Builder**. The Query Builder lets you:

- pick a profile + layout from dropdowns
- enter the find request as JSON — the layout's field names show up as
  **clickable chips above the editor** so you don't have to type them
- preview results in a sortable table
- save the query for re-use, with optional **export** to JSON or CSV
- copy the equivalent `curl` or `fetch` snippet for sharing or bug reports

Saved queries are scoped per workspace by default. Use
**FileMaker: Export Saved Queries (JSON)** to share them with your team
via Git or chat, or change `filemaker.savedQueries.scope` to `global` to
make them follow you between workspaces.

That's it — you're ready to go. The full command list is in the palette
under the **FileMaker:** prefix.
