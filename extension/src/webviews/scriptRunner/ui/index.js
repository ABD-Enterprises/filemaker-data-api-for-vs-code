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
  scriptRunnerEnabled: true,
  includeAuthByDefault: false
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const scriptNameInput = document.getElementById('scriptNameInput');
const scriptParamInput = document.getElementById('scriptParamInput');
const includeAuthCheckbox = document.getElementById('includeAuthCheckbox');
const runButton = document.getElementById('runButton');
const copyCurlButton = document.getElementById('copyCurlButton');
const copyFetchButton = document.getElementById('copyFetchButton');
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const rawResult = document.getElementById('rawResult');
const scriptRunnerPanels = Array.from(document.querySelectorAll('.panel'));
const scriptRunnerSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
let scriptRunnerReady = false;

const scriptRunnerHeader = document.querySelector('.header');
if (scriptRunnerHeader && scriptRunnerPanels.length > 0) {
  scriptRunnerHeader.insertAdjacentElement('afterend', scriptRunnerSkeleton);
  setElementsVisible(scriptRunnerPanels, false);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init':
      applyInit(message.payload);
      revealScriptRunner();
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      break;
    case 'scriptResult':
      renderResult(message.payload);
      break;
    case 'unsupported':
      setStatus(
        message.message || t('webviews.scriptRunner.ui.unsupported', 'Script runner unsupported.'),
        true
      );
      runButton.disabled = true;
      break;
    case 'error':
      setStatus(
        message.message || t('webviews.scriptRunner.ui.unknownError', 'Unknown error.'),
        true
      );
      break;
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  requestLayouts(profileSelect.value);
});

runButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  setStatus(t('webviews.scriptRunner.ui.runningScript', 'Running script...'));
  vscode.postMessage({
    type: 'runScript',
    payload
  });
});

copyCurlButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyCurl',
    payload: {
      ...payload,
      includeAuthHeader: includeAuthCheckbox.checked
    }
  });
});

copyFetchButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyFetch',
    payload: {
      ...payload,
      includeAuthHeader: includeAuthCheckbox.checked
    }
  });
});

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;
  state.scriptRunnerEnabled = payload.scriptRunnerEnabled !== false;
  state.includeAuthByDefault = payload.includeAuthByDefault === true;

  includeAuthCheckbox.checked = state.includeAuthByDefault;
  runButton.disabled = !state.scriptRunnerEnabled;

  if (!state.scriptRunnerEnabled) {
    setStatus(
      t('webviews.scriptRunner.ui.disabledBySetting', 'Script runner is disabled by setting.'),
      true
    );
  }

  renderProfiles();

  if (state.defaults && typeof state.defaults.recordId === 'string') {
    recordIdInput.value = state.defaults.recordId;
  }

  setStatus(t('webviews.scriptRunner.ui.ready', 'Ready.'));
}

function renderProfiles() {
  if (
    !syncSelectOptions(
      profileSelect,
      state.profiles,
      (profile) => profile.id,
      (profile) => `${profile.name} (${profile.database})`,
      t('webviews.scriptRunner.ui.noProfilesConfigured', 'No profiles configured')
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

function requestLayouts(profileId, preferredLayout) {
  if (!profileId) {
    return;
  }

  const cached = state.layoutsByProfile.get(profileId);
  if (cached) {
    renderLayouts(cached, preferredLayout);
    return;
  }

  setStatus(t('webviews.scriptRunner.ui.loadingLayouts', 'Loading layouts...'));
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
  if (
    !syncSelectOptions(
      layoutSelect,
      Array.isArray(layouts) ? layouts : [],
      (layout) => layout,
      (layout) => layout,
      t('webviews.scriptRunner.ui.noLayoutsAvailable', 'No layouts available')
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

function collectPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  const scriptName = scriptNameInput.value.trim();

  if (!profileId) {
    setStatus(t('webviews.scriptRunner.ui.selectProfile', 'Select a profile.'), true);
    return undefined;
  }

  if (!layout) {
    setStatus(t('webviews.scriptRunner.ui.selectLayout', 'Select a layout.'), true);
    return undefined;
  }

  if (!scriptName) {
    setStatus(t('webviews.scriptRunner.ui.enterScriptName', 'Enter a script name.'), true);
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId: recordIdInput.value.trim(),
    scriptName,
    scriptParam: scriptParamInput.value
  };
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

function syncSelectOptions(select, items, getValue, getLabel, emptyLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.replaceChildren(option);
    return false;
  }

  const existingOptions = new Map(
    Array.from(select.options).map((option) => [option.value, option])
  );

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

function setElementsVisible(elements, isVisible) {
  elements.forEach((element) => {
    element.style.display = isVisible ? '' : 'none';
  });

  scriptRunnerSkeleton.classList.toggle('hidden', isVisible);
}

function revealScriptRunner() {
  if (scriptRunnerReady) {
    return;
  }

  scriptRunnerReady = true;
  setElementsVisible(scriptRunnerPanels, true);
}

function renderResult(payload) {
  const result = payload && payload.result ? payload.result : {};
  const messages = Array.isArray(result.messages) ? result.messages : [];

  summary.textContent = messages.length
    ? t(
        'webviews.scriptRunner.ui.messagesSummary',
        'Messages: {0}',
        messages.map((item) => `${item.code}:${item.message}`).join(' | ')
      )
    : t('webviews.scriptRunner.ui.scriptExecuted', 'Script executed.');

  rawResult.textContent = JSON.stringify(payload, null, 2);
  setStatus(t('webviews.scriptRunner.ui.executionCompleted', 'Script execution completed.'));
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

vscode.postMessage({ type: 'ready' });
