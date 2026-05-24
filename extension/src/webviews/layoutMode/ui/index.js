(function () {
  const vscode = acquireVsCodeApi();
  function t(key, fallback, ...args) {
    const messages = window.fileMakerI18n || {};
    const template = typeof messages[key] === 'string' ? messages[key] : fallback;
    return template.replace(/\{(\d+)\}/g, function (match, index) {
      return Object.prototype.hasOwnProperty.call(args, index) ? String(args[index]) : match;
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'init') {
      var root = document.getElementById('root');
      if (root) {
        root.textContent = t(
          'webviews.layoutMode.ui.bundleMissing',
          'Layout Mode UI bundle is missing. Build designer-ui to enable the React designer.'
        );
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
