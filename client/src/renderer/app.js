/**
 * Aion Electron Client — Renderer Process
 *
 * Manages the connect/disconnect lifecycle and proxies the SPA from the server.
 */

(function () {
  'use strict';

  // ── DOM refs ──
  const connectForm = document.getElementById('connectForm');
  const serverUrlInput = document.getElementById('serverUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const saveCheckbox = document.getElementById('saveSettings');
  const connectBtn = document.getElementById('connectBtn');
  const connectBtnText = document.getElementById('connectBtnText');
  const connectSpinner = document.getElementById('connectSpinner');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const errorMsg = document.getElementById('errorMsg');
  const toggleKeyBtn = document.getElementById('toggleKey');
  const connectCard = document.getElementById('connectCard');
  const appContainer = document.getElementById('appContainer');
  const appView = document.getElementById('appView');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const connLabel = document.getElementById('connLabel');
  const connIndicator = document.getElementById('connIndicator');

  // ── State ──
  let isConnecting = false;
  let connected = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let currentProxyPort = null;
  const MAX_RECONNECT_ATTEMPTS = 10;

  // ── Load saved settings ──
  function loadSavedSettings() {
    try {
      const saved = localStorage.getItem('aion_connection');
      if (saved) {
        const data = JSON.parse(saved);
        if (data.serverUrl) serverUrlInput.value = data.serverUrl;
        if (data.apiKey) apiKeyInput.value = data.apiKey;
        if (data.serverUrl || data.apiKey) saveCheckbox.checked = true;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  function saveSettings() {
    if (saveCheckbox.checked) {
      localStorage.setItem('aion_connection', JSON.stringify({
        serverUrl: serverUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        savedAt: Date.now(),
      }));
    } else {
      localStorage.removeItem('aion_connection');
    }
  }

  // ── Status updates ──
  function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;

    if (state === 'connected') {
      connectBtnText.textContent = 'Connected ✓';
      connectBtn.disabled = true;
      connectSpinner.style.display = 'none';
      errorMsg.style.display = 'none';
    } else if (state === 'connecting') {
      connectBtnText.textContent = 'Connecting...';
      connectBtn.disabled = true;
      connectSpinner.style.display = 'flex';
      errorMsg.style.display = 'none';
    } else {
      connectBtnText.textContent = 'Connect';
      connectBtn.disabled = false;
      connectSpinner.style.display = 'none';
    }
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
    setStatus('error', 'Connection failed');
  }

  function hideError() {
    errorMsg.style.display = 'none';
  }

  // ── Exponential backoff ──
  function getBackoffDelay(attempt) {
    return Math.min(1000 * Math.pow(2, attempt), 30000);
  }

  // ── Auto-reconnect ──
  function scheduleReconnect(serverUrl, apiKey) {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      showError('Max reconnection attempts reached. Please connect manually.');
      isConnecting = false;
      return;
    }

    reconnectAttempt++;
    const delay = getBackoffDelay(reconnectAttempt - 1);
    const totalSec = Math.round(delay / 1000);

    statusDot.className = 'status-dot connecting';
    statusText.textContent = `Reconnecting in ${totalSec}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      doConnect(serverUrl, apiKey);
    }, delay);
  }

  // ── Connect ──
  async function doConnect(serverUrl, apiKey) {
    if (isConnecting) return;
    isConnecting = true;
    hideError();

    setStatus('connecting', 'Connecting...');
    saveSettings();

    try {
      const result = await window.aionAPI.connect({ serverUrl, apiKey });

      if (result.success) {
        connected = true;
        reconnectAttempt = 0;
        currentProxyPort = result.proxyPort;
        setStatus('connected', 'Connected ✓');
        showAppView(result.proxyPort);
      } else {
        showError(result.error || 'Connection failed. Check your server URL and API key.');
        isConnecting = false;
      }
    } catch (err) {
      // If we were previously connected, attempt auto-reconnect
      if (connected) {
        scheduleReconnect(serverUrl, apiKey);
      } else {
        showError(err.message || 'Connection failed. Is the server running?');
      }
      isConnecting = false;
    }
  }

  // ── Show application view ──
  function showAppView(proxyPort) {
    connectCard.style.display = 'none';
    appContainer.style.display = 'flex';
    connLabel.textContent = 'Connected';
    connIndicator.className = 'connection-indicator connected';

    // Load the Aion SPA through the local proxy
    const proxyUrl = `http://127.0.0.1:${proxyPort}/`;
    appView.src = proxyUrl;

    // Listen for disconnection
    window.aionAPI.onConnectionStatus((status) => {
      if (status === 'disconnected') {
        connLabel.textContent = 'Disconnected';
        connIndicator.className = 'connection-indicator disconnected';
        connected = false;

        // Try to reconnect
        const serverUrl = serverUrlInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        if (serverUrl && apiKey) {
          scheduleReconnect(serverUrl, apiKey);
        }
      }
    });
  }

  // ── Disconnect ──
  async function doDisconnect() {
    try {
      await window.aionAPI.disconnect();
    } catch (e) {
      // Ignore errors on disconnect
    }

    connected = false;
    isConnecting = false;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;

    appContainer.style.display = 'none';
    connectCard.style.display = 'block';

    setStatus('', 'Disconnected');
    connLabel.textContent = 'Disconnected';
    connIndicator.className = 'connection-indicator disconnected';
  }

  // ── Toggle password visibility ──
  let keyVisible = false;
  toggleKeyBtn.addEventListener('click', () => {
    keyVisible = !keyVisible;
    apiKeyInput.type = keyVisible ? 'text' : 'password';
  });

  // ── Form submission ──
  connectForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const serverUrl = serverUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!serverUrl) {
      showError('Server URL is required.');
      return;
    }

    if (!apiKey) {
      showError('API key is required.');
      return;
    }

    doConnect(serverUrl, apiKey);
  });

  // ── Disconnect button ──
  disconnectBtn.addEventListener('click', doDisconnect);

  // ── Keyboard shortcut: Enter to connect ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connected) {
      // Let form submission handle it
    }
  });

  // ── Bootstrap ──
  loadSavedSettings();

  // If settings are saved, try auto-connect
  const savedUrl = serverUrlInput.value.trim();
  const savedKey = apiKeyInput.value.trim();
  if (savedUrl && savedKey) {
    doConnect(savedUrl, savedKey);
  }

})();
