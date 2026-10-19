import { SNIPPET_FORMATS } from './model';

/**
 * The "Copy request for this record" disclosure of the Record Viewer and Record Editor. It is static
 * markup (no data from the database is put in it); the panel script reads the two selects and posts
 * `copyRecordRequest`.
 */
export function copyRecordRequestMenuHtml(): string {
  const formats = SNIPPET_FORMATS.map((format) => `<option value="${format.id}">${format.label}</option>`).join('');
  return `<details class="menu" id="copyRecordMenu">
          <summary class="secondary">Copy request for this record</summary>
          <div class="menu-items menu-form">
            <label for="copyOperationSelect">Request</label>
            <select id="copyOperationSelect">
              <option value="get">Get this record</option>
              <option value="edit">Edit this record (modId to fill in)</option>
              <option value="delete">Delete this record</option>
            </select>
            <label for="copyFormatSelect">Format</label>
            <select id="copyFormatSelect">${formats}</select>
            <button id="copyRecordButton" type="button">Copy</button>
            <button id="saveRecordHttpButton" type="button" title="Opens the request in a new editor. Save it where you want.">Save as .http file…</button>
          </div>
        </details>`;
}
