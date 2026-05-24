const vscode = acquireVsCodeApi();

function t(key, fallback, ...args) {
  const messages = window.fileMakerI18n || {};
  const template = typeof messages[key] === 'string' ? messages[key] : fallback;
  return template.replace(/\{(\d+)\}/g, (match, index) =>
    Object.prototype.hasOwnProperty.call(args, index) ? String(args[index]) : match
  );
}

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
const discardButton = document.getElementById('discardButton');
const exportButton = document.getElementById('exportButton');
const statusEl = document.getElementById('status');
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
    case 'saveCancelled':
      setStatus(t('webviews.recordEditor.ui.saveCancelled', 'Save cancelled.'));
      break;
    case 'error':
      setStatus(
        message.message || t('webviews.recordEditor.ui.unknownError', 'Unknown error.'),
        true
      );
      break;
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  loadLayouts(profileSelect.value);
});

loadButton.addEventListener('click', () => {
  const payload = collectBasePayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'loadRecord', payload });
  setStatus(t('webviews.recordEditor.ui.loadingRecord', 'Loading record...'));
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
  setStatus(t('webviews.recordEditor.ui.saving', 'Saving...'));
});

discardButton.addEventListener('click', () => {
  if (!state.loaded) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  state.draftFieldData = { ...state.originalFieldData };
  renderFieldEditor();
  setStatus(t('webviews.recordEditor.ui.draftDiscarded', 'Draft changes discarded.'));
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportRecord' });
});

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;

  renderProfiles();
  setStatus(t('webviews.recordEditor.ui.ready', 'Ready.'));
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
  state.loaded = payload;
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);

  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  setStatus(
    t('webviews.recordEditor.ui.loadedRecord', 'Loaded record {0}.', payload.record.recordId)
  );
}

function applyValidation(payload) {
  if (!payload) {
    return;
  }

  if (payload.valid) {
    setStatus(t('webviews.recordEditor.ui.draftValid', 'Draft is valid.'));
    return;
  }

  const details = Array.isArray(payload.errors)
    ? payload.errors.map((item) => `${item.field}: ${item.message}`).join(' | ')
    : t('webviews.recordEditor.ui.validationFailed', 'Validation failed.');
  setStatus(details, true);
}

function applyPatchPreview(payload) {
  patchPreview.textContent = JSON.stringify(payload, null, 2);
  const count = payload && Array.isArray(payload.changedFields) ? payload.changedFields.length : 0;
  setStatus(
    t(
      'webviews.recordEditor.ui.patchPreviewReady',
      'Patch preview ready ({0} changed field{1}).',
      count,
      count === 1 ? '' : 's'
    )
  );
}

function applySaved(payload) {
  if (!payload || !payload.record || !payload.record.fieldData) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);
  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  revealRecordEditor();
  setStatus(t('webviews.recordEditor.ui.recordSaved', 'Record saved.'));
}

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
    option.textContent = t('webviews.recordEditor.ui.noProfiles', 'No profiles');
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
    option.textContent = t('webviews.recordEditor.ui.noLayouts', 'No layouts');
    layoutSelect.appendChild(option);
    return;
  }

  for (const layout of layouts) {
    const option = document.createElement('option');
    option.value = layout;
    option.textContent = layout;
    layoutSelect.appendChild(option);
  }

  if (preferredLayout && layouts.includes(preferredLayout)) {
    layoutSelect.value = preferredLayout;
  } else {
    layoutSelect.value = layouts[0];
  }
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
  empty.textContent = t('webviews.recordEditor.ui.noFieldData', 'No fieldData available.');
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
  fieldHeader.textContent = t('webviews.recordEditor.ui.fieldHeader', 'Field');
  headerRow.appendChild(fieldHeader);

  const valueHeader = document.createElement('th');
  valueHeader.textContent = t('webviews.recordEditor.ui.valueHeader', 'Value');
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
    setStatus(t('webviews.recordEditor.ui.unsavedChanges', 'Draft has unsaved changes.'));
  }
}

function collectBasePayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  const recordId = recordIdInput.value.trim();

  if (!profileId || !layout || !recordId) {
    setStatus(
      t('webviews.recordEditor.ui.requiredFields', 'Profile, layout, and record ID are required.'),
      true
    );
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
