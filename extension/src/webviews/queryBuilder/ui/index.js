const vscode = acquireVsCodeApi();

const state = {
  profiles: [],
  activeProfileId: undefined,
  layoutsByProfile: new Map(),
  savedQueries: [],
  currentPayload: undefined,
  currentQueryId: undefined,
  lastResult: undefined,
  defaults: undefined,
  history: []
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const findJson = document.getElementById('findJson');
const sortJson = document.getElementById('sortJson');
const limitInput = document.getElementById('limitInput');
const offsetInput = document.getElementById('offsetInput');
const queryNameInput = document.getElementById('queryNameInput');
const includeAuthCheckbox = document.getElementById('includeAuthCheckbox');
const runButton = document.getElementById('runButton');
const saveButton = document.getElementById('saveButton');
const exportEditorButton = document.getElementById('exportEditorButton');
const exportJsonButton = document.getElementById('exportJsonButton');
const exportCsvButton = document.getElementById('exportCsvButton');
const copyFetchButton = document.getElementById('copyFetchButton');
const copyCurlButton = document.getElementById('copyCurlButton');
const uploadContainerButton = document.getElementById('uploadContainerButton');
const savedQueriesSelect = document.getElementById('savedQueriesSelect');
const loadSavedButton = document.getElementById('loadSavedButton');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const refreshHistoryButton = document.getElementById('refreshHistoryButton');
const rawToggle = document.getElementById('rawToggle');
const status = document.getElementById('status');
const resultSummary = document.getElementById('resultSummary');
const tableContainer = document.getElementById('tableContainer');
const rawContainer = document.getElementById('rawContainer');
const historyContainer = document.getElementById('historyContainer');
const queryBuilderPanels = Array.from(document.querySelectorAll('.panel'));
const queryBuilderSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long', 'medium']);
const standardResultTable = {
  columnsKey: '',
  wrapper: undefined,
  tbody: undefined,
  rows: new Map()
};
let queryBuilderReady = false;

const queryBuilderHeader = document.querySelector('.header');
if (queryBuilderHeader && queryBuilderPanels.length > 0) {
  queryBuilderHeader.insertAdjacentElement('afterend', queryBuilderSkeleton);
  setElementsVisible(queryBuilderPanels, false);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init':
      applyInit(message.payload);
      revealQueryBuilder();
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      requestFieldNamesForCurrentLayout();
      break;
    case 'fieldNamesLoaded':
      renderFieldNames(message.payload);
      break;
    case 'queryResult':
      renderQueryResult(message.payload);
      break;
    case 'savedQueries':
      state.savedQueries = Array.isArray(message.payload) ? message.payload : [];
      renderSavedQueries();
      setStatus('Saved queries updated.');
      break;
    case 'history':
      state.history = Array.isArray(message.payload) ? message.payload : [];
      renderHistory();
      break;
    case 'saveCurrentQuery':
      saveButton.click();
      break;
    case 'containerUploadResult':
      setStatus(
        message.payload && message.payload.completed
          ? 'Container upload completed.'
          : 'Container upload cancelled.'
      );
      break;
    case 'error':
      setStatus(message.message || 'Unknown error.', true);
      break;
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  const profileId = profileSelect.value;
  requestLayouts(profileId);
});

if (layoutSelect) {
  layoutSelect.addEventListener('change', () => {
    requestFieldNamesForCurrentLayout();
  });
}

runButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  state.currentPayload = payload;
  setStatus('Running query...');
  vscode.postMessage({
    type: 'runQuery',
    payload
  });
});

saveButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  const name = queryNameInput.value.trim();
  if (!name) {
    setStatus('Enter a name before saving query.', true);
    return;
  }

  vscode.postMessage({
    type: 'saveQuery',
    payload: {
      ...payload,
      name
    }
  });
});

exportEditorButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsToEditor' });
});

exportJsonButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsJsonFile' });
});

exportCsvButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsCsvFile' });
});

copyFetchButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyFetchSnippet',
    payload: {
      ...payload,
      includeAuthHeader: includeAuthCheckbox.checked
    }
  });
});

copyCurlButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyCurlSnippet',
    payload: {
      ...payload,
      includeAuthHeader: includeAuthCheckbox.checked
    }
  });
});

uploadContainerButton.addEventListener('click', () => {
  const payload = collectProfileLayoutPayload();
  if (!payload) {
    return;
  }

  setStatus('Opening container upload...');
  vscode.postMessage({
    type: 'uploadContainer',
    payload
  });
});

loadSavedButton.addEventListener('click', () => {
  const selectedId = savedQueriesSelect.value;
  const selected = state.savedQueries.find((item) => item.id === selectedId);

  if (!selected) {
    setStatus('Select a saved query to load.', true);
    return;
  }

  applySavedQuery(selected);
  setStatus(`Loaded saved query "${selected.name}".`);
});

rawToggle.addEventListener('change', () => {
  renderResultView();
});

prevButton.addEventListener('click', () => {
  const limit = parseNumber(limitInput.value) ?? 100;
  const currentOffset = parseNumber(offsetInput.value) ?? 0;
  offsetInput.value = String(Math.max(0, currentOffset - limit));
  runButton.click();
});

nextButton.addEventListener('click', () => {
  const limit = parseNumber(limitInput.value) ?? 100;
  const currentOffset = parseNumber(offsetInput.value) ?? 0;
  offsetInput.value = String(currentOffset + limit);
  runButton.click();
});

refreshHistoryButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshHistory' });
});

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.savedQueries = Array.isArray(payload.savedQueries) ? payload.savedQueries : [];
  state.defaults = payload.defaults;

  includeAuthCheckbox.checked = payload.includeAuthByDefault === true;

  renderProfiles();
  renderSavedQueries();

  const defaultFind = findJson.value.trim();
  if (!defaultFind) {
    findJson.value = '[{}]';
  }

  if (payload.defaults && payload.defaults.savedQuery) {
    applySavedQuery(payload.defaults.savedQuery);
  }

  setStatus('Ready.');

  // Focus the profile select once the init data has rendered so SR + keyboard
  // users land on the primary control instead of the document root.
  if (profileSelect && typeof profileSelect.focus === 'function') {
    profileSelect.focus();
  }
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

function renderProfiles() {
  if (
    !syncSelectOptions(
      profileSelect,
      state.profiles,
      (profile) => profile.id,
      (profile) => `${profile.name} (${profile.database})`,
      'No profiles configured'
    )
  ) {
    return;
  }

  let selectedProfileId = state.defaults && state.defaults.profileId;
  if (!selectedProfileId) {
    selectedProfileId = state.activeProfileId || state.profiles[0].id;
  }

  if (!state.profiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = state.profiles[0].id;
  }

  profileSelect.value = selectedProfileId;
  requestLayouts(selectedProfileId, state.defaults && state.defaults.layout);
}

function renderLayouts(layouts, preferredLayout) {
  if (
    !syncSelectOptions(
      layoutSelect,
      Array.isArray(layouts) ? layouts : [],
      (layout) => layout,
      (layout) => layout,
      'No layouts available'
    )
  ) {
    return;
  }

  if (preferredLayout && layouts.includes(preferredLayout)) {
    layoutSelect.value = preferredLayout;
    return;
  }

  if (!layouts.includes(layoutSelect.value)) {
    layoutSelect.value = layouts[0];
  }
}

function requestLayouts(profileId, preferredLayout) {
  if (!profileId) {
    return;
  }

  const cachedLayouts = state.layoutsByProfile.get(profileId);
  if (cachedLayouts) {
    renderLayouts(cachedLayouts, preferredLayout);
    return;
  }

  setStatus('Loading layouts...');
  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
}

function collectPayload() {
  const base = collectProfileLayoutPayload();
  if (!base) {
    return undefined;
  }

  return {
    ...base,
    findJson: findJson.value,
    sortJson: sortJson.value,
    limit: parseNumber(limitInput.value),
    offset: parseNumber(offsetInput.value),
    queryId: state.currentQueryId
  };
}

function collectProfileLayoutPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;

  if (!profileId) {
    setStatus('Select a profile.', true);
    return undefined;
  }

  if (!layout) {
    setStatus('Select a layout.', true);
    return undefined;
  }

  return {
    profileId,
    layout
  };
}

function parseNumber(value) {
  if (value === '' || value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

  queryBuilderSkeleton.classList.toggle('hidden', isVisible);
}

function revealQueryBuilder() {
  if (queryBuilderReady) {
    return;
  }

  queryBuilderReady = true;
  setElementsVisible(queryBuilderPanels, true);
}

function renderQueryResult(payload) {
  state.lastResult = payload;
  renderResultView();

  const total = Array.isArray(payload.result && payload.result.data) ? payload.result.data.length : 0;
  setStatus(`Query completed. Returned ${total} records.`);

  vscode.postMessage({ type: 'refreshHistory' });
}

function renderResultView() {
  if (!state.lastResult) {
    resultSummary.textContent = 'No results yet.';
    clearTableContainer();
    rawContainer.textContent = '';
    return;
  }

  const result = state.lastResult.result || {};
  const records = Array.isArray(result.data) ? result.data : [];

  const summaryParts = [`Records: ${records.length}`];
  if (state.lastResult.query) {
    summaryParts.push(`Layout: ${state.lastResult.query.layout}`);
  }
  resultSummary.textContent = summaryParts.join(' | ');

  rawContainer.textContent = JSON.stringify(state.lastResult, null, 2);

  if (rawToggle.checked) {
    rawContainer.classList.remove('hidden');
    clearTableContainer();
    return;
  }

  rawContainer.classList.add('hidden');

  if (records.length === 0) {
    clearTableContainer();
    tableContainer.appendChild(createEmptyMessage('No records returned.'));
    return;
  }

  const columns = collectColumns(records);

  if (records.length >= 50) {
    resetStandardResultTable();
    tableContainer.replaceChildren();
    renderVirtualizedTable(records, columns);
    return;
  }

  renderStandardTable(records, columns);
}

function collectColumns(records) {
  const seen = new Set();

  for (const record of records) {
    const fieldData = record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
    Object.keys(fieldData).forEach((key) => seen.add(key));
  }

  return Array.from(seen).slice(0, 60);
}

function toCellValue(value) {
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

function renderSavedQueries() {
  savedQueriesSelect.innerHTML = '';

  if (!Array.isArray(state.savedQueries) || state.savedQueries.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No saved queries';
    savedQueriesSelect.appendChild(option);
    return;
  }

  for (const query of state.savedQueries) {
    const option = document.createElement('option');
    option.value = query.id;
    option.textContent = `${query.name} (${query.layout})`;
    savedQueriesSelect.appendChild(option);
  }
}

function applySavedQuery(query) {
  state.currentQueryId = query.id;

  profileSelect.value = query.profileId;
  requestLayouts(query.profileId, query.layout);

  findJson.value = JSON.stringify(query.findJson || [], null, 2);
  sortJson.value = query.sortJson ? JSON.stringify(query.sortJson, null, 2) : '';
  limitInput.value = query.limit !== undefined ? String(query.limit) : '';
  offsetInput.value = query.offset !== undefined ? String(query.offset) : '';
  queryNameInput.value = query.name;
}

function renderHistory() {
  if (!Array.isArray(state.history) || state.history.length === 0) {
    historyContainer.replaceChildren(createEmptyMessage('No history entries yet.'));
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  ['Time', 'Operation', 'Profile', 'Layout', 'Status', 'Duration'].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const entry of state.history) {
    const row = document.createElement('tr');

    addCell(row, entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '');
    addCell(row, entry.operation || '');
    addCell(row, entry.profileId || '');
    addCell(row, entry.layout || '-');
    addCell(row, entry.success ? 'Success' : 'Failure');
    addCell(row, `${entry.durationMs || 0}ms`);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  historyContainer.replaceChildren(wrapper);
}

function addCell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.appendChild(td);
}

function clearTableContainer() {
  resetStandardResultTable();
  tableContainer.replaceChildren();
}

function createEmptyMessage(message) {
  const empty = document.createElement('p');
  empty.textContent = message;
  return empty;
}

function syncSelectOptions(select, items, getValue, getLabel, emptyLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.replaceChildren(option);
    return false;
  }

  const existingOptions = new Map(Array.from(select.options).map((option) => [option.value, option]));

  items.forEach((item, index) => {
    const value = getValue(item);
    const label = getLabel(item);
    let option = existingOptions.get(value);

    if (!option) {
      option = document.createElement('option');
      option.value = value;
    }

    option.textContent = label;

    if (select.children[index] !== option) {
      select.insertBefore(option, select.children[index] || null);
    }

    existingOptions.delete(value);
  });

  existingOptions.forEach((option) => option.remove());
  return true;
}

function resetStandardResultTable() {
  standardResultTable.columnsKey = '';
  standardResultTable.wrapper = undefined;
  standardResultTable.tbody = undefined;
  standardResultTable.rows.clear();
}

function renderStandardTable(records, columns) {
  const columnsKey = columns.join('\u0000');
  if (!standardResultTable.tbody || standardResultTable.columnsKey !== columnsKey) {
    const tableState = buildStandardTableState(columns);
    standardResultTable.columnsKey = columnsKey;
    standardResultTable.wrapper = tableState.wrapper;
    standardResultTable.tbody = tableState.tbody;
    standardResultTable.rows.clear();
    tableContainer.replaceChildren(tableState.wrapper);
  } else if (standardResultTable.wrapper && tableContainer.firstElementChild !== standardResultTable.wrapper) {
    tableContainer.replaceChildren(standardResultTable.wrapper);
  }

  const rowKeys = createStableRowKeys(records);
  rowKeys.forEach((rowKey, index) => {
    let rowState = standardResultTable.rows.get(rowKey);
    if (!rowState) {
      rowState = createResultRowState(columns);
      standardResultTable.rows.set(rowKey, rowState);
    }

    updateResultRowState(rowState, records[index], columns);
    standardResultTable.tbody.appendChild(rowState.row);
  });

  Array.from(standardResultTable.rows.entries()).forEach(([rowKey, rowState]) => {
    if (!rowKeys.includes(rowKey)) {
      rowState.row.remove();
      standardResultTable.rows.delete(rowKey);
    }
  });
}

function buildStandardTableState(columns) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const idHeader = document.createElement('th');
  idHeader.textContent = 'recordId';
  headerRow.appendChild(idHeader);

  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return { wrapper, tbody };
}

function createResultRowState(columns) {
  const row = document.createElement('tr');
  const idCell = document.createElement('td');
  row.appendChild(idCell);

  const cells = new Map();
  for (const column of columns) {
    const td = document.createElement('td');
    cells.set(column, td);
    row.appendChild(td);
  }

  return { row, idCell, cells };
}

function updateResultRowState(rowState, record, columns) {
  const nextRecordId = String(record.recordId || '');
  if (rowState.idCell.textContent !== nextRecordId) {
    rowState.idCell.textContent = nextRecordId;
  }

  const fieldData =
    record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
  columns.forEach((column) => {
    const cell = rowState.cells.get(column);
    const nextValue = toCellValue(fieldData[column]);
    if (cell && cell.textContent !== nextValue) {
      cell.textContent = nextValue;
    }
  });
}

function createStableRowKeys(records) {
  const counts = new Map();
  records.forEach((record) => {
    const recordId =
      record && record.recordId !== undefined && record.recordId !== null
        ? String(record.recordId)
        : '';
    counts.set(recordId, (counts.get(recordId) || 0) + 1);
  });

  return records.map((record, index) => {
    const recordId =
      record && record.recordId !== undefined && record.recordId !== null
        ? String(record.recordId)
        : '';
    if (!recordId || counts.get(recordId) > 1) {
      return `row-${index}`;
    }

    return `record-${recordId}`;
  });
}

function renderVirtualizedTable(records, columns) {
  const container = document.createElement('div');
  container.className = 'virtual-wrap';
  container.style.height = '360px';
  container.style.overflow = 'auto';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const idHeader = document.createElement('th');
  idHeader.textContent = 'recordId';
  headerRow.appendChild(idHeader);

  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  container.appendChild(table);
  tableContainer.appendChild(container);

  const rowHeight = 30;
  const buffer = 18;

  const renderSlice = () => {
    const visibleCount = Math.ceil(container.clientHeight / rowHeight) + buffer;
    const start = Math.max(0, Math.floor(container.scrollTop / rowHeight) - Math.floor(buffer / 2));
    const end = Math.min(records.length, start + visibleCount);

    const topSpacer = document.createElement('tr');
    topSpacer.style.height = `${start * rowHeight}px`;
    const topSpacerCell = document.createElement('td');
    topSpacerCell.colSpan = columns.length + 1;
    topSpacer.appendChild(topSpacerCell);

    const sliceRows = [topSpacer];

    for (let index = start; index < end; index += 1) {
      const rowState = createResultRowState(columns);
      updateResultRowState(rowState, records[index], columns);
      sliceRows.push(rowState.row);
    }

    const bottomSpacer = document.createElement('tr');
    bottomSpacer.style.height = `${Math.max(0, (records.length - end) * rowHeight)}px`;
    const bottomSpacerCell = document.createElement('td');
    bottomSpacerCell.colSpan = columns.length + 1;
    bottomSpacer.appendChild(bottomSpacerCell);
    sliceRows.push(bottomSpacer);

    tbody.replaceChildren(...sliceRows);
  };

  let rafPending = false;
  const scheduleRenderSlice = () => {
    if (rafPending) {
      return;
    }

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderSlice();
    });
  };

  container.addEventListener('scroll', scheduleRenderSlice);
  scheduleRenderSlice();
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function requestFieldNamesForCurrentLayout() {
  const profileId = profileSelect ? profileSelect.value : '';
  const layout = layoutSelect ? layoutSelect.value : '';
  if (!profileId || !layout) {
    renderFieldNames({ profileId: '', layout: '', fieldNames: [] });
    return;
  }
  vscode.postMessage({ type: 'loadFieldNames', profileId, layout });
}

function renderFieldNames(payload) {
  let panel = document.getElementById('fieldNamesPanel');
  if (!panel) {
    const findContainer = findJson ? findJson.parentElement : null;
    if (!findContainer) return;
    panel = document.createElement('div');
    panel.id = 'fieldNamesPanel';
    panel.className = 'field-names-panel';
    findContainer.insertBefore(panel, findJson);
  }

  const names = Array.isArray(payload && payload.fieldNames) ? payload.fieldNames : [];
  const error = payload && payload.error;
  panel.innerHTML = '';

  if (error) {
    const msg = document.createElement('div');
    msg.className = 'field-names-error';
    msg.textContent = `Layout fields unavailable: ${error}`;
    panel.appendChild(msg);
    return;
  }

  if (names.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';

  const header = document.createElement('div');
  header.className = 'field-names-header';
  header.textContent = `Layout fields (${names.length}) — click to insert`;
  panel.appendChild(header);

  const chipRow = document.createElement('div');
  chipRow.className = 'field-names-chips';
  for (const name of names) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'field-name-chip';
    chip.textContent = name;
    chip.title = `Insert "${name}" into the find JSON`;
    chip.addEventListener('click', () => insertFieldNameIntoFindJson(name));
    chipRow.appendChild(chip);
  }
  panel.appendChild(chipRow);
}

function insertFieldNameIntoFindJson(fieldName) {
  if (!findJson) return;
  const insertion = `"${fieldName}": ""`;
  const start = findJson.selectionStart ?? findJson.value.length;
  const end = findJson.selectionEnd ?? findJson.value.length;
  const before = findJson.value.slice(0, start);
  const after = findJson.value.slice(end);
  const needsComma = /[}\]"]\s*$/.test(before.trim());
  const prefix = needsComma ? ', ' : '';
  findJson.value = `${before}${prefix}${insertion}${after}`;
  const cursor = (before + prefix + insertion).length - 1; // place caret between the empty quotes
  findJson.focus();
  findJson.setSelectionRange(cursor, cursor);
}

vscode.postMessage({ type: 'ready' });
