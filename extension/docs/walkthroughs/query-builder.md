# Step 3 — Run your first query

With an active connection, you've got two paths:

## Quick: list layouts and pick a record

Run **FileMaker: List Layouts** to see every layout exposed via the Data
API. Right-click a layout in the sidebar to get common actions:
**Open Query Builder**, **Get Record by ID**, **Open Layout Metadata**,
**Generate Types for Layout**, **Batch Export (Find)**.

## Powerful: the Query Builder

Run **FileMaker: Open Query Builder**. The query builder lets you:

- pick a profile + layout from dropdowns
- enter the find request as JSON (the layout's field names show up as
  clickable chips above the editor — click to insert)
- preview results in a table
- save the query for re-use, with optional **export** to JSON/CSV files
- copy the equivalent `curl` or `fetch` snippet to share or paste into a
  bug report

Saved queries are scoped per workspace by default. Use
**FileMaker: Export Saved Queries (JSON)** if you want to share them with
your team via Git or a chat tool.

That's it — you're ready to go. The full command list is in the palette
under the **FileMaker:** prefix.
