const vscode = acquireVsCodeApi();

function t(key, fallback, ...args) {
  const messages = window.fileMakerI18n || {};
  const template = typeof messages[key] === 'string' ? messages[key] : fallback;
  return template.replace(/\{(\d+)\}/g, (match, index) =>
    Object.prototype.hasOwnProperty.call(args, index) ? String(args[index]) : match
  );
}

const state = {
  profiles: [],
  activeProfileId: undefined,
  defaults: undefined,
  layoutsByProfile: new Map(),
  lastRecord: undefined
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const loadButton = document.getElementById('loadButton');
const exportButton = document.getElementById('exportButton');
const status = document.getElementById('status');
const fieldDataContainer = document.getElementById('fieldDataContainer');
const relatedDataContainer = document.getElementById('relatedDataContainer');
const rawJson = document.getElementById('rawJson');
const fieldCellRefs = new Map();
const portalSectionRefs = new Map();
const recordViewerPanel = fieldDataContainer.closest('.panel');
const recordViewerHeading = recordViewerPanel ? recordViewerPanel.querySelector('h2') : null;
const recordViewerContent = recordViewerPanel
  ? Array.from(recordViewerPanel.children).filter((element) => element.tagName !== 'H2')
  : [fieldDataContainer, relatedDataContainer, rawJson];
const recordViewerSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
let recordViewerReady = false;

if (recordViewerPanel) {
  if (recordViewerHeading) {
    recordViewerHeading.insertAdjacentElement('afterend', recordViewerSkeleton);
  } else {
    recordViewerPanel.prepend(recordViewerSkeleton);
  }

  setElementsVisible(recordViewerContent, false);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init': {
      applyInit(message.payload);
      break;
    }
    case 'layoutsLoaded': {
      applyLayouts(message.payload);
      break;
    }
    case 'recordLoaded': {
      renderRecord(message.payload);
      revealRecordViewer();
      break;
    }
    case 'error': {
      setStatus(
        message.message || t('webviews.recordViewer.ui.unknownError', 'Unknown error.'),
        true
      );
      break;
    }
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  requestLayouts(profileSelect.value);
});

loadButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  setStatus(t('webviews.recordViewer.ui.loadingRecord', 'Loading record...'));
  vscode.postMessage({
    type: 'loadRecord',
    payload
  });
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportRecord' });
});

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;

  renderProfiles();

  if (state.defaults && state.defaults.recordId) {
    recordIdInput.value = state.defaults.recordId;
  }

  setStatus(t('webviews.recordViewer.ui.ready', 'Ready.'));
}

function renderProfiles() {
  profileSelect.innerHTML = '';

  if (state.profiles.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t(
      'webviews.recordViewer.ui.noProfilesConfigured',
      'No profiles configured'
    );
    profileSelect.appendChild(option);
    return;
  }

  for (const profile of state.profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.database})`;
    profileSelect.appendChild(option);
  }

  let profileId = state.defaults && state.defaults.profileId;
  if (!profileId) {
    profileId = state.activeProfileId || state.profiles[0].id;
  }

  profileSelect.value = profileId;
  requestLayouts(profileId, state.defaults && state.defaults.layout);
}

function requestLayouts(profileId, preferredLayout) {
  if (!profileId) {
    return;
  }

  const cached = state.layoutsByProfile.get(profileId);
  if (cached) {
    renderLayouts(cached, preferredLayout);
    return;
  }

  setStatus(t('webviews.recordViewer.ui.loadingLayouts', 'Loading layouts...'));
  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
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

function renderLayouts(layouts, preferredLayout) {
  layoutSelect.innerHTML = '';

  if (!Array.isArray(layouts) || layouts.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('webviews.recordViewer.ui.noLayoutsAvailable', 'No layouts available');
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

function collectPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  const recordId = recordIdInput.value.trim();

  if (!profileId) {
    setStatus(t('webviews.recordViewer.ui.selectProfile', 'Select a profile.'), true);
    return undefined;
  }

  if (!layout) {
    setStatus(t('webviews.recordViewer.ui.selectLayout', 'Select a layout.'), true);
    return undefined;
  }

  if (!recordId) {
    setStatus(t('webviews.recordViewer.ui.enterRecordId', 'Enter a record ID.'), true);
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId
  };
}

function renderRecord(payload) {
  state.lastRecord = payload;

  const record = payload.record || {};
  const fieldData =
    record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
  const relatedData =
    record.portalData && typeof record.portalData === 'object' ? record.portalData : {};

  renderFieldData(fieldData);
  renderPortalData(relatedData);

  rawJson.textContent = JSON.stringify(payload, null, 2);
  setStatus(
    t('webviews.recordViewer.ui.loadedRecord', 'Loaded record {0}.', record.recordId || '')
  );
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

  recordViewerSkeleton.classList.toggle('hidden', isVisible);
}

function revealRecordViewer() {
  if (recordViewerReady) {
    return;
  }

  recordViewerReady = true;
  setElementsVisible(recordViewerContent, true);
}

function renderFieldData(fieldData) {
  const fieldKeys = Object.keys(fieldData);
  if (!fieldKeys.length) {
    fieldCellRefs.clear();
    fieldDataContainer.replaceChildren(
      createEmptyMessage(t('webviews.recordViewer.ui.noFieldData', 'No field data.'))
    );
    return;
  }

  if (!hasMatchingFieldCells(fieldKeys)) {
    buildFieldTable(fieldData, fieldKeys);
    return;
  }

  updateFieldCells(fieldData, fieldKeys);
}

function hasMatchingFieldCells(fieldKeys) {
  return (
    fieldCellRefs.size === fieldKeys.length &&
    fieldKeys.every((fieldKey) => fieldCellRefs.has(fieldKey))
  );
}

function buildFieldTable(fieldData, fieldKeys) {
  fieldCellRefs.clear();

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  const fieldHeader = document.createElement('th');
  fieldHeader.textContent = t('webviews.recordViewer.ui.fieldHeader', 'Field');
  headRow.appendChild(fieldHeader);

  const valueHeader = document.createElement('th');
  valueHeader.textContent = t('webviews.recordViewer.ui.valueHeader', 'Value');
  headRow.appendChild(valueHeader);

  const copyHeader = document.createElement('th');
  copyHeader.textContent = t('webviews.recordViewer.ui.copyHeader', 'Copy');
  headRow.appendChild(copyHeader);

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const field of fieldKeys) {
    const row = document.createElement('tr');

    const fieldCell = document.createElement('td');
    fieldCell.textContent = field;
    row.appendChild(fieldCell);

    const valueCell = document.createElement('td');
    valueCell.textContent = toText(fieldData[field]);
    fieldCellRefs.set(field, valueCell);
    row.appendChild(valueCell);

    const copyCell = document.createElement('td');
    const copyButton = document.createElement('button');
    copyButton.textContent = t('webviews.recordViewer.ui.copyButton', 'Copy');
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(valueCell.textContent || '');
      setStatus(t('webviews.recordViewer.ui.copiedField', 'Copied {0}.', field));
    });
    copyCell.appendChild(copyButton);
    row.appendChild(copyCell);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  fieldDataContainer.replaceChildren(wrapper);
}

function updateFieldCells(fieldData, fieldKeys) {
  fieldKeys.forEach((fieldKey) => {
    const cell = fieldCellRefs.get(fieldKey);
    const nextValue = toText(fieldData[fieldKey]);
    if (cell && cell.textContent !== nextValue) {
      cell.textContent = nextValue;
    }
  });
}

function renderPortalData(relatedData) {
  const portalKeys = Object.keys(relatedData);
  if (!portalKeys.length) {
    portalSectionRefs.clear();
    relatedDataContainer.replaceChildren(
      createEmptyMessage(t('webviews.recordViewer.ui.noRelatedRows', 'No related rows.'))
    );
    return;
  }

  if (!hasMatchingPortalSections(portalKeys)) {
    buildPortalSections(relatedData, portalKeys);
    return;
  }

  updatePortalSections(relatedData, portalKeys);
}

function hasMatchingPortalSections(portalKeys) {
  return (
    portalSectionRefs.size === portalKeys.length &&
    portalKeys.every((portalKey) => portalSectionRefs.has(portalKey))
  );
}

function buildPortalSections(relatedData, portalKeys) {
  portalSectionRefs.clear();
  relatedDataContainer.replaceChildren();

  portalKeys.forEach((portalKey) => {
    const details = document.createElement('details');
    details.className = 'related-block';

    const summary = document.createElement('summary');
    details.appendChild(summary);

    const content = renderRelatedRows(
      Array.isArray(relatedData[portalKey]) ? relatedData[portalKey] : []
    );
    details.appendChild(content);

    portalSectionRefs.set(portalKey, { details, summary, content });
    relatedDataContainer.appendChild(details);
  });

  updatePortalSections(relatedData, portalKeys);
}

function updatePortalSections(relatedData, portalKeys) {
  portalKeys.forEach((portalKey) => {
    const section = portalSectionRefs.get(portalKey);
    if (!section) {
      return;
    }

    const entries = Array.isArray(relatedData[portalKey]) ? relatedData[portalKey] : [];
    section.summary.textContent = `${portalKey} (${entries.length})`;
    section.content.textContent = entries.length
      ? JSON.stringify(entries, null, 2)
      : t('webviews.recordViewer.ui.noRelatedRows', 'No related rows.');
  });
}

function renderRelatedRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = t('webviews.recordViewer.ui.noRelatedRows', 'No related rows.');
    return empty;
  }

  const pre = document.createElement('pre');
  pre.className = 'raw-small';
  pre.textContent = JSON.stringify(rows, null, 2);
  return pre;
}

function toText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function createEmptyMessage(message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

vscode.postMessage({ type: 'ready' });
