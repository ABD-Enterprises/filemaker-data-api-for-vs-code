# E2E UI report

Generated 2026-10-18T18:18:06.985Z

Totals: PASS 11, FAIL 1

| Journey | Step | Expectation | Result | Screenshot | Detail |
|---|---|---|---|---|---|
| J04 query builder | open the Query Builder | panel opens with Profile, Layout, Find JSON and Run | PASS | screenshots/001-J04_query_builder-open_the_Query_Builder.png | layout selected: Customers |
| J04 query builder | find all records (default [{}]) | first page of 100 rows, found count 220, Next enabled | PASS | screenshots/002-J04_query_builder-find_all_records_default_.png | Showing 1–100 of 220 found · 220 in table · Customers (32 DOM rows, table is virtualised) |
| J04 query builder | page forward and back | Next shows records 101-200 (server offset 101), Previous returns | PASS | screenshots/003-J04_query_builder-page_forward_and_back.png | after Next: Showing 101–200 of 220 found · 220 in table · Customers; last request POST /layouts/Customers/_find  {"query":[{}],"limit":100,"offset":101} |
| J04 query builder | find by field value via the Form tab | form conditions produce the right find (Status equals Open) | PASS | screenshots/004-J04_query_builder-find_by_field_value_via_the_Form_tab.png | Showing 1–45 of 45 found · 220 in table · Customers \| operators: matches, equals (whole field), begins with, contains phrase, greater than, at least, less than, at most, between, is empty, is not empty \| request {"query":[{"Status":"==Open"}],"limit":100,"offset":1} |
| J04 query builder | sort through the JSON tab (descending Balance) | rows come back in descending order | PASS | screenshots/005-J04_query_builder-sort_through_the_JSON_tab_descending_Ba.png |  |
| J04 query builder | click a column header to sort the loaded page | the table re-orders | PASS | screenshots/006-J04_query_builder-click_a_column_header_to_sort_the_loaded.png | Berners-Lee \| Berners-Lee \| Berners-Lee \| Dijkstra \| Dijkstra |
| J04 query builder | no matches: HTTP 404 + FileMaker code 401 | a friendly empty result, not an error | PASS | screenshots/007-J04_query_builder-no_matches_HTTP_404_FileMaker_code_40.png | summary: "No records found on Customers." status: "Query completed. 0 records returned." |
| J04 query builder | invalid JSON in the Find box | a clear validation message, no request sent | PASS | screenshots/008-J04_query_builder-invalid_JSON_in_the_Find_box.png | Find JSON must be valid JSON. |
| J04 query builder | open a record from the results (double-click) | Record Viewer opens with the field data | FAIL | screenshots/009-J04_query_builder-open_a_record_from_the_results_double-c.png | Record Viewer opened from a results row only after clicking Load Record (the panel opened for a record id but stayed on the loading skeleton for 10 s) |
| J04 query builder | copy results as table | tab-separated text on the clipboard with a header row | PASS | screenshots/010-J04_query_builder-copy_results_as_table.png | 6 lines |
| J04 query builder | Save results as CSV: formulas are neutralised | cells starting with = + - @ tab CR are prefixed so spreadsheets do not run them | PASS | screenshots/011-J04_query_builder-Save_results_as_CSV_formulas_are_neutra.png | 19 lines; un-neutralised formula cells: 0; cells that already began with an apostrophe and got a second one: 8; cells starting with a space or line feed before a formula character (left as is): 4 |
| J04 query builder | Save results as JSON and open results in editor | JSON file exists; editor shows the records | PASS | screenshots/012-J04_query_builder-Save_results_as_JSON_and_open_results_in.png | FileMaker Query Builder, Untitled-1, FileMaker Record Viewer |
