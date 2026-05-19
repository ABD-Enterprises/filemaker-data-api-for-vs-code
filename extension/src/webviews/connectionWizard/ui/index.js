// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

document.addEventListener('DOMContentLoaded', () => {
  // The HTML template wraps everything in <form id="wizardForm">. If that ever
  // gets refactored away (it did before — silent regression), fall back to
  // document.body so the input/change/submit listeners still install instead
  // of throwing on null and halting the rest of the script (which would skip
  // Save/Test/message bindings below).
  const form = /** @type {HTMLElement} */ (
    document.getElementById('wizardForm') || document.body
  );
  const directBtn = /** @type {HTMLButtonElement} */ (document.getElementById('modeDirectBtn'));
  const proxyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('modeProxyBtn'));
  const directFields = /** @type {HTMLElement} */ (document.getElementById('directFields'));
  const proxyFields = /** @type {HTMLElement} */ (document.getElementById('proxyFields'));
  const saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('saveBtn'));
  const testBtn = /** @type {HTMLButtonElement} */ (document.getElementById('testBtn'));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));

  let authMode = 'direct';
  /** @type {'off'|'warn'|'block'} */
  let testPolicy = 'warn';
  /** @type {{state:'untested'|'success'|'failure'|'stale', message?:string, hash?:string}} */
  let testState = { state: 'untested' };
  let pendingConfirmedSave = false;

  // Mode toggle
  directBtn.addEventListener('click', () => {
    authMode = 'direct';
    directBtn.classList.add('active');
    proxyBtn.classList.remove('active');
    directBtn.setAttribute('aria-pressed', 'true');
    proxyBtn.setAttribute('aria-pressed', 'false');
    directFields.classList.add('visible');
    proxyFields.classList.remove('visible');
    onFormChanged();
  });

  proxyBtn.addEventListener('click', () => {
    authMode = 'proxy';
    proxyBtn.classList.add('active');
    directBtn.classList.remove('active');
    proxyBtn.setAttribute('aria-pressed', 'true');
    directBtn.setAttribute('aria-pressed', 'false');
    proxyFields.classList.add('visible');
    directFields.classList.remove('visible');
    onFormChanged();
  });

  // Initialize
  directBtn.classList.add('active');
  directFields.classList.add('visible');

  // Focus the first input so screen-reader + keyboard users land on
  // something actionable immediately, not at the document root.
  const firstInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profileName'));
  if (firstInput) {
    firstInput.focus();
  }

  // Track every input edit
  form.addEventListener('input', onFormChanged);
  form.addEventListener('change', onFormChanged);

  // Pressing Enter inside an <input> in a <form> would otherwise trigger a
  // navigation/reload of the webview. The CSP blocks inline onsubmit, so we
  // attach the suppression here.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  // Save
  saveBtn.addEventListener('click', () => {
    const data = collectFormData();
    if (!data) {
      return;
    }

    const currentHash = hashForm(data);
    const guard = evaluateSaveGuard(currentHash);

    if (guard === 'block') {
      showStatus(
        'error',
        'Save blocked by policy: please run a successful Test Connection on the current values first.'
      );
      return;
    }

    if (guard === 'warn' && !pendingConfirmedSave) {
      showConfirmation(currentHash);
      return;
    }

    pendingConfirmedSave = false;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    clearStatus();
    vscode.postMessage({ type: 'save', payload: data });
  });

  // Test connection
  testBtn.addEventListener('click', () => {
    const data = collectFormData();
    if (!data) {
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    clearStatus();

    vscode.postMessage({ type: 'testConnection', payload: data });
  });

  // Message handling
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'init':
        if (message.testPolicy === 'off' || message.testPolicy === 'warn' || message.testPolicy === 'block') {
          testPolicy = message.testPolicy;
        }
        renderTestState();
        break;

      case 'saveSuccess':
        showStatus('success', message.message || 'Profile saved successfully.');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Profile';
        break;

      case 'saveError':
        showStatus('error', message.message || 'Failed to save profile.');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Profile';
        break;

      case 'testStarted': {
        showTestProgress('Reaching server…', message.timeoutMs);
        break;
      }

      case 'testProgress': {
        showTestProgress(message.phase || 'Working…');
        break;
      }

      case 'testSuccess': {
        const data = collectFormData();
        const hash = data ? hashForm(data) : undefined;
        testState = { state: 'success', message: message.message, hash };
        showStatus('success', message.message || 'Connection successful.');
        hideTestProgress();
        renderTestState();
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
        break;
      }

      case 'testError': {
        const data = collectFormData();
        const hash = data ? hashForm(data) : undefined;
        testState = { state: 'failure', message: message.message, hash };
        showStatus('error', message.message || 'Connection failed.');
        hideTestProgress();
        renderTestState();
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
        break;
      }

      case 'loadProfile':
        populateForm(message.payload);
        break;
    }
  });

  function collectFormData() {
    const name = getValue('profileName');
    const serverUrl = getValue('serverUrl');
    const database = getValue('database');
    const apiBasePath = getValue('apiBasePath');
    const apiVersionPath = getValue('apiVersionPath');

    if (!name || !serverUrl || !database) {
      showStatus('error', 'Profile name, server URL, and database are required.');
      return null;
    }

    const data = {
      name,
      authMode,
      serverUrl,
      database,
      apiBasePath: apiBasePath || '/fmi/data',
      apiVersionPath: apiVersionPath || 'vLatest'
    };

    if (authMode === 'direct') {
      const username = getValue('username');
      const password = getValue('password');
      if (!username) {
        showStatus('error', 'Username is required for direct mode.');
        return null;
      }
      return { ...data, username, password };
    }

    const proxyEndpoint = getValue('proxyEndpoint');
    const proxyApiKey = getValue('proxyApiKey');
    if (!proxyEndpoint) {
      showStatus('error', 'Proxy endpoint is required for proxy mode.');
      return null;
    }
    return { ...data, proxyEndpoint, proxyApiKey };
  }

  function populateForm(profile) {
    if (!profile) return;
    setFieldValue('profileName', profile.name || '');
    setFieldValue('serverUrl', profile.serverUrl || '');
    setFieldValue('database', profile.database || '');
    setFieldValue('apiBasePath', profile.apiBasePath || '/fmi/data');
    setFieldValue('apiVersionPath', profile.apiVersionPath || 'vLatest');

    if (profile.authMode === 'proxy') {
      proxyBtn.click();
      setFieldValue('proxyEndpoint', profile.proxyEndpoint || '');
    } else {
      directBtn.click();
      setFieldValue('username', profile.username || '');
    }
    onFormChanged();
  }

  function getValue(id) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    return el ? el.value.trim() : '';
  }

  function setFieldValue(id, value) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.value = value;
  }

  function showStatus(type, message) {
    statusEl.className = 'status ' + type;
    statusEl.textContent = message;
  }

  function clearStatus() {
    statusEl.className = 'status';
    statusEl.textContent = '';
  }

  function onFormChanged() {
    pendingConfirmedSave = false;
    if (testState.state === 'success' || testState.state === 'failure') {
      const data = collectFormData();
      const newHash = data ? hashForm(data) : undefined;
      if (newHash !== testState.hash) {
        testState = { state: 'stale', message: testState.message };
      }
    }
    renderTestState();
  }

  function showTestProgress(phase, timeoutMs) {
    let el = document.getElementById('testProgress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'testProgress';
      el.className = 'test-progress';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const buttonsContainer = saveBtn.parentElement;
      if (buttonsContainer) {
        buttonsContainer.insertBefore(el, saveBtn);
      } else {
        document.body.appendChild(el);
      }
    }
    const timeoutHint =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? ` (timeout ${Math.round(timeoutMs / 1000)}s)`
        : '';

    // Build the spinner + label via DOM APIs (textContent is safe; innerHTML with
    // a postMessage-sourced phase string trips CodeQL's client-side-XSS check).
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
    const spinner = document.createElement('span');
    spinner.className = 'test-progress-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'test-progress-text';
    text.textContent = `${phase}${timeoutHint}`;
    el.appendChild(spinner);
    el.appendChild(text);
    el.style.display = '';
  }

  function hideTestProgress() {
    const el = document.getElementById('testProgress');
    if (el) {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  function renderTestState() {
    let badge = document.getElementById('testBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'testBadge';
      badge.className = 'test-badge';
      const buttonsContainer = saveBtn.parentElement;
      if (buttonsContainer) {
        buttonsContainer.insertBefore(badge, saveBtn);
      } else {
        document.body.appendChild(badge);
      }
    }

    let label = '';
    let cls = 'test-badge';
    switch (testState.state) {
      case 'untested':
        label = testPolicy === 'off' ? '' : '⚪ Connection not tested';
        cls += ' untested';
        break;
      case 'success':
        label = '🟢 Test passed';
        cls += ' success';
        break;
      case 'failure':
        label = `🔴 Test failed${testState.message ? ': ' + testState.message : ''}`;
        cls += ' failure';
        break;
      case 'stale':
        label = '🟡 Edits since last test';
        cls += ' stale';
        break;
    }
    badge.textContent = label;
    badge.className = cls;
    badge.style.display = label ? '' : 'none';
  }

  /**
   * @param {string} hash
   * @returns {'ok'|'warn'|'block'}
   */
  function evaluateSaveGuard(hash) {
    if (testPolicy === 'off') return 'ok';
    const passed = testState.state === 'success' && testState.hash === hash;
    if (passed) return 'ok';
    return testPolicy === 'block' ? 'block' : 'warn';
  }

  function showConfirmation(hash) {
    const confirmed = window.confirm(
      'You have not run a successful Test Connection on the current values. Save anyway?'
    );
    if (confirmed) {
      pendingConfirmedSave = true;
      saveBtn.click();
    }
  }

  /**
   * @param {Record<string, unknown>} data
   * @returns {string}
   */
  function hashForm(data) {
    // Stable, order-independent hash. Excludes secrets so the form is considered
    // "tested" even after the user re-enters a password (tests didn't change auth values
    // unless the auth fields themselves changed).
    const subset = {
      name: data.name,
      authMode: data.authMode,
      serverUrl: data.serverUrl,
      database: data.database,
      apiBasePath: data.apiBasePath,
      apiVersionPath: data.apiVersionPath,
      username: data.username,
      proxyEndpoint: data.proxyEndpoint
    };
    return JSON.stringify(subset);
  }

  // Tell the extension we're ready
  vscode.postMessage({ type: 'ready' });
});
