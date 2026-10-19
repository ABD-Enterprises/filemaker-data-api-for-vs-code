const vscode = acquireVsCodeApi();

function debounce(fn, ms) {
  let timer;
  function wrapped(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  }

  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return wrapped;
}

const state = {
  // 'edit' loads and saves one record; 'create' lists a layout's fields and creates a new record.
  mode: 'edit',
  profiles: [],
  activeProfileId: undefined,
  defaults: undefined,
  layoutsByProfile: new Map(),
  loaded: undefined,
  originalFieldData: {},
  draftFieldData: {}
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const loadButton = document.getElementById('loadButton');
const validateButton = document.getElementById('validateButton');
const previewButton = document.getElementById('previewButton');
const saveButton = document.getElementById('saveButton');
const createButton = document.getElementById('createButton');
const recordIdRow = document.getElementById('recordIdRow');
const discardButton = document.getElementById('discardButton');
const exportButton = document.getElementById('exportButton');
const statusEl = document.getElementById('status');
const hiddenNote = document.getElementById('hiddenNote');
const conflictBanner = document.getElementById('conflictBanner');
const conflictText = document.getElementById('conflictText');
const reloadAfterConflictButton = document.getElementById('reloadAfterConflictButton');
const fieldEditor = document.getElementById('fieldEditor');
const patchPreview = document.getElementById('patchPreview');
const rawRecord = document.getElementById('rawRecord');
const fieldInputs = new Map();
const recordEditorPanel = fieldEditor.closest('.panel');
const recordEditorHeading = recordEditorPanel ? recordEditorPanel.querySelector('h2') : null;
const recordEditorContent = recordEditorPanel
  ? Array.from(recordEditorPanel.children).filter((element) => element.tagName !== 'H2')
  : [fieldEditor, patchPreview, rawRecord];
const recordEditorSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
const debouncedMarkDirtyState = debounce(markDirtyState, 200);
let recordEditorReady = false;

if (recordEditorPanel) {
  if (recordEditorHeading) {
    recordEditorHeading.insertAdjacentElement('afterend', recordEditorSkeleton);
  } else {
    recordEditorPanel.prepend(recordEditorSkeleton);
  }

  setElementsVisible(recordEditorContent, false);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init':
      applyInit(message.payload);
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      break;
    case 'recordLoaded':
      applyRecord(message.payload);
      revealRecordEditor();
      break;
    case 'draftValidated':
      applyValidation(message.payload);
      break;
    case 'patchPreview':
      applyPatchPreview(message.payload);
      break;
    case 'recordSaved':
      applySaved(message.payload);
      break;
    case 'layoutFields':
      applyLayoutFields(message.payload);
      break;
    case 'recordCreated':
      applyCreated(message.payload);
      break;
    case 'saveCancelled':
      setStatus('Save cancelled.');
      break;
    case 'saveConflict':
      showConflict(message.payload);
      break;
    case 'error':
      setStatus(message.message || 'Unknown error.', true);
      break;
    default:
      break;
  }
});

layoutSelect.addEventListener('change', () => {
  hideConflict();
  requestCreateFields();
});

profileSelect.addEventListener('change', () => {
  hideConflict();
  loadLayouts(profileSelect.value);
});

loadButton.addEventListener('click', () => {
  const payload = collectBasePayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'loadRecord', payload });
  setStatus('Loading record...');
});

validateButton.addEventListener('click', () => {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'validateDraft', payload });
});

previewButton.addEventListener('click', () => {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'previewPatch', payload });
});

saveButton.addEventListener('click', () => {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  vscode.postMessage({ type: 'saveRecord', payload });
  setStatus('Saving...');
});

discardButton.addEventListener('click', () => {
  if (!state.loaded) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  state.draftFieldData = { ...state.originalFieldData };
  renderFieldEditor();
  setStatus('Draft changes discarded.');
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportRecord' });
});

createButton.addEventListener('click', () => {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  if (!profileId || !layout) {
    setStatus('Profile and layout are required.', true);
    return;
  }

  const fieldData = {};
  for (const [name, value] of Object.entries(state.draftFieldData)) {
    if (value !== '' && value !== undefined && value !== null) {
      fieldData[name] = value;
    }
  }
  if (Object.keys(fieldData).length === 0) {
    setStatus('Enter a value in at least one field to create a record.', true);
    return;
  }

  debouncedMarkDirtyState.cancel();
  vscode.postMessage({ type: 'createRecord', payload: { profileId, layout, fieldData } });
  setStatus('Creating record...');
});

function applyMode() {
  const creating = state.mode === 'create';
  recordIdRow.classList.toggle('hidden', creating);
  createButton.classList.toggle('hidden', !creating);
  for (const button of [loadButton, previewButton, saveButton, discardButton, exportButton]) {
    button.classList.toggle('hidden', creating);
  }
  if (recordEditorHeading) {
    recordEditorHeading.textContent = creating ? 'New Record' : 'Field Data';
  }
  // The patch preview and raw JSON belong to editing an existing record.
  patchPreview.parentElement.querySelectorAll('h3, pre').forEach((element) => element.classList.toggle('hidden', creating));
  if (creating) {
    // Nothing to load: show the (empty) form straight away.
    revealRecordEditor();
  }
}

function requestCreateFields() {
  if (state.mode !== 'create' || !profileSelect.value || !layoutSelect.value) {
    return;
  }

  vscode.postMessage({
    type: 'loadLayoutFields',
    payload: { profileId: profileSelect.value, layout: layoutSelect.value }
  });
  setStatus('Loading fields...');
}

function applyLayoutFields(payload) {
  if (state.mode !== 'create' || !payload || !Array.isArray(payload.fields)) {
    return;
  }
  if (payload.profileId !== profileSelect.value || payload.layout !== layoutSelect.value) {
    return;
  }

  state.originalFieldData = {};
  state.draftFieldData = {};
  for (const field of payload.fields) {
    if (field && typeof field.name === 'string') {
      state.draftFieldData[field.name] = '';
    }
  }
  fieldInputs.clear();
  renderFieldEditor();
  setStatus(
    payload.metadataSupported
      ? `Enter values for the new record, then click Create Record (${payload.fields.length} fields).`
      : (payload.message || 'Field list is unavailable for this layout.'),
    !payload.metadataSupported
  );
}

function applyCreated(payload) {
  if (!payload) {
    return;
  }

  // Start the next record from an empty form and show the id of the one just created.
  for (const name of Object.keys(state.draftFieldData)) {
    state.draftFieldData[name] = '';
  }
  renderFieldEditor();
  setStatus(`Record created on ${payload.layout}: record ID ${payload.recordId}${payload.modId ? ` (modId ${payload.modId})` : ''}.`);
}

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;
  state.mode = payload.defaults && payload.defaults.mode === 'create' ? 'create' : 'edit';
  applyMode();

  renderProfiles();
  setStatus('Ready.');
}

function applyLayouts(payload) {
  if (!payload || typeof payload.profileId !== 'string' || !Array.isArray(payload.layouts)) {
    return;
  }

  state.layoutsByProfile.set(payload.profileId, payload.layouts);
  if (profileSelect.value === payload.profileId) {
    renderLayouts(payload.layouts, state.defaults && state.defaults.layout);
    state.defaults = undefined;
  }
}

function applyRecord(payload) {
  if (!payload || !payload.record || !payload.record.fieldData) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  hideConflict();
  state.loaded = payload;
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);

  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  showHiddenFieldNote(payload);
  setStatus(`Loaded record ${payload.record.recordId}.`);
}

/**
 * Fields the account cannot see are simply not in the answer. Say so, and name the fields the layout
 * lists that this record has no value for (the only ones the page can know about).
 */
function showHiddenFieldNote(payload) {
  if (!hiddenNote) {
    return;
  }
  const present = new Set(Object.keys(payload.record.fieldData));
  const listed = Array.isArray(payload.fields) ? payload.fields.map((field) => field && field.name).filter((name) => typeof name === 'string') : [];
  const missing = listed.filter((name) => !present.has(name));
  let text = 'Fields your account has no access to are not shown here.';
  if (missing.length > 0) {
    const names = missing.slice(0, 5).join(', ') + (missing.length > 5 ? `, and ${missing.length - 5} more` : '');
    text = `${missing.length} field${missing.length === 1 ? '' : 's'} on this layout ${missing.length === 1 ? 'is' : 'are'} not shown (hidden by your account or its privileges): ${names}. ${text}`;
  }
  hiddenNote.textContent = text;
  hiddenNote.classList.remove('hidden');
}

function applyValidation(payload) {
  if (!payload) {
    return;
  }

  if (payload.valid) {
    setStatus('Draft is valid.');
    return;
  }

  const details = Array.isArray(payload.errors)
    ? payload.errors.map((item) => `${item.field}: ${item.message}`).join(' | ')
    : 'Validation failed.';
  setStatus(details, true);
}

function applyPatchPreview(payload) {
  patchPreview.textContent = JSON.stringify(payload, null, 2);
  const count = payload && Array.isArray(payload.changedFields) ? payload.changedFields.length : 0;
  setStatus(`Patch preview ready (${count} changed field${count === 1 ? '' : 's'}).`);
}

function applySaved(payload) {
  if (!payload || !payload.record || !payload.record.fieldData) {
    return;
  }

  hideConflict();
  debouncedMarkDirtyState.cancel();
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);
  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  revealRecordEditor();
  setStatus('Record saved.');
}

function showConflict(payload) {
  const recordId = payload && payload.recordId ? payload.recordId : recordIdInput.value.trim();
  const others = payload && Array.isArray(payload.changedByOthers) ? payload.changedByOthers : [];
  const overlap = payload && Array.isArray(payload.overlap) ? payload.overlap : [];

  let text = `Not saved: record ${recordId} was changed by someone else after you opened it.`;
  if (others.length > 0) {
    text += ` Fields changed since: ${others.join(', ')}.`;
  }
  if (overlap.length > 0) {
    text += ` You both edited: ${overlap.join(', ')}.`;
  }
  text += ' Your edits are still in the form. Reload to see the current values, then redo your changes.';

  conflictText.textContent = text;
  conflictBanner.classList.remove('hidden');
  setStatus('Save blocked: the record changed since you loaded it.', true);
  reloadAfterConflictButton.focus();
}

function hideConflict() {
  conflictBanner.classList.add('hidden');
  conflictText.textContent = '';
}

reloadAfterConflictButton.addEventListener('click', () => {
  hideConflict();
  loadButton.click();
});

function createLoadingSkeleton(widths) {
  const skeleton = document.createElement('div');
  skeleton.className = 'loading-skeleton';

  widths.forEach((width) => {
    const line = document.createElement('div');
    line.className = `skeleton-line ${width}`;
    skeleton.appendChild(line);
  });

  return skeleton;
}

function setElementsVisible(elements, isVisible) {
  elements.forEach((element) => {
    element.style.display = isVisible ? '' : 'none';
  });

  recordEditorSkeleton.classList.toggle('hidden', isVisible);
}

function revealRecordEditor() {
  if (recordEditorReady) {
    return;
  }

  recordEditorReady = true;
  setElementsVisible(recordEditorContent, true);
}

function renderProfiles() {
  profileSelect.innerHTML = '';

  if (!state.profiles.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No profiles';
    profileSelect.appendChild(option);
    return;
  }

  for (const profile of state.profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.database})`;
    profileSelect.appendChild(option);
  }

  const selected =
    (state.defaults && state.defaults.profileId) || state.activeProfileId || state.profiles[0].id;
  profileSelect.value = selected;
  loadLayouts(selected, state.defaults && state.defaults.layout);

  if (state.defaults && state.defaults.recordId) {
    recordIdInput.value = state.defaults.recordId;
  }
}

function renderLayouts(layouts, preferredLayout) {
  layoutSelect.innerHTML = '';

  if (!Array.isArray(layouts) || !layouts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No layouts';
    layoutSelect.appendChild(option);
    return;
  }

  for (const layout of layouts) {
    const option = document.createElement('option');
    option.value = layout;
    option.textContent = layout;
    option.title = layout; // the full name, since a long one is clipped in the list
    layoutSelect.appendChild(option);
  }

  if (preferredLayout && layouts.includes(preferredLayout)) {
    layoutSelect.value = preferredLayout;
  } else {
    layoutSelect.value = layouts[0];
  }
  requestCreateFields();
}

function loadLayouts(profileId, preferredLayout) {
  const cached = state.layoutsByProfile.get(profileId);
  if (cached) {
    renderLayouts(cached, preferredLayout);
    return;
  }

  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
}

function renderFieldEditor() {
  const keys = Object.keys(state.draftFieldData).sort((a, b) => a.localeCompare(b));
  if (!keys.length) {
    showEmptyFieldEditor();
    return;
  }

  if (!hasMatchingFieldInputs(keys)) {
    buildFieldEditor(keys);
    return;
  }

  updateFieldEditorValues(keys);
}

function hasMatchingFieldInputs(keys) {
  return fieldInputs.size === keys.length && keys.every((key) => fieldInputs.has(key));
}

function showEmptyFieldEditor() {
  fieldInputs.clear();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'No fieldData available.';
  fieldEditor.replaceChildren(empty);
}

function buildFieldEditor(keys) {
  fieldInputs.clear();

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const fieldHeader = document.createElement('th');
  fieldHeader.textContent = 'Field';
  headerRow.appendChild(fieldHeader);

  const valueHeader = document.createElement('th');
  valueHeader.textContent = 'Value';
  headerRow.appendChild(valueHeader);
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const key of keys) {
    const tr = document.createElement('tr');

    const labelCell = document.createElement('td');
    labelCell.textContent = key;
    tr.appendChild(labelCell);

    const inputCell = document.createElement('td');
    const input = document.createElement('textarea');
    input.rows = 2;
    input.value = toEditableValue(state.draftFieldData[key]);
    input.addEventListener('input', () => {
      state.draftFieldData[key] = parseEditableValue(input.value);
      debouncedMarkDirtyState();
    });
    fieldInputs.set(key, input);
    inputCell.appendChild(input);
    tr.appendChild(inputCell);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  fieldEditor.replaceChildren(wrapper);
}

function updateFieldEditorValues(keys) {
  for (const key of keys) {
    const input = fieldInputs.get(key);
    if (!input) {
      continue;
    }

    input.value = toEditableValue(state.draftFieldData[key]);
  }
}

function markDirtyState() {
  const changed = JSON.stringify(state.originalFieldData) !== JSON.stringify(state.draftFieldData);
  if (changed) {
    setStatus('Draft has unsaved changes.');
  }
}

function collectBasePayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  // A new record has no id yet; the host ignores it when validating a draft.
  const recordId = state.mode === 'create' ? '(new)' : recordIdInput.value.trim();

  if (!profileId || !layout || !recordId) {
    setStatus('Profile, layout, and record ID are required.', true);
    return undefined;
  }

  return { profileId, layout, recordId };
}

function collectDraftPayload() {
  const base = collectBasePayload();
  if (!base) {
    return undefined;
  }

  return {
    ...base,
    originalFieldData: state.originalFieldData,
    draftFieldData: state.draftFieldData
  };
}

function toEditableValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function parseEditableValue(value) {
  const trimmed = value.trim();
  if (!trimmed.length) {
    return '';
  }

  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

vscode.postMessage({ type: 'ready' });
