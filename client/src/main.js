/**
 * Aion Electron Client — Main Process
 *
 * Connects to an Aion server via WebSocket, starts a local HTTP proxy,
 * and displays the Aion SPA in a branded desktop window.
 *
 * Architecture:
 *   1. Show a connection settings screen (src/renderer/)
 *   2. User enters Server URL + API Key, clicks Connect
 *   3. Main process establishes WebSocket to ws://SERVER/ws?key=API_KEY
 *   4. Main process starts a local HTTP server on a random port
 *   5. Renderer loads http://localhost:PORT/ — main proxies requests
 *      through the WebSocket tunnel to the real server
 *   6. Full Aion SPA appears in the BrowserWindow with minimal chrome
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ── State ──
let mainWindow = null;
let wsConnection = null;
let proxyServer = null;
let proxyPort = 0;
let isConnected = false;

// ── Helpers ──
function log(msg) {
  console.log(`[Aion Client] ${msg}`);
}

// ── WebSocket Client (built-in, no ws package needed for client) ──
function connectWebSocket(serverUrl, apiKey) {
  return new Promise((resolve, reject) => {
    // Build WebSocket URL
    let wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'ws:');
    if (!wsUrl.endsWith('/ws')) {
      wsUrl = wsUrl.replace(/\/+$/, '') + '/ws';
    }
    wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);

    log(`Connecting to ${wsUrl}...`);

    let ws;
    try {
      // Node.js 22 has built-in WebSocket
      ws = new globalThis.WebSocket(wsUrl);
    } catch (e) {
      // Fallback for older Node
      reject(new Error('WebSocket not supported in this Node.js version. Node 22+ required.'));
      return;
    }

    const timeout = setTimeout(() => {
      if (ws.readyState !== ws.OPEN) {
        ws.close();
        reject(new Error('Connection timeout'));
      }
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);
      log('WebSocket connected');
      isConnected = true;
      wsConnection = ws;
      resolve(ws);
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      log(`WebSocket error: ${err.message || err}`);
      reject(new Error(err.message || 'Connection failed'));
    };

    ws.onclose = () => {
      isConnected = false;
      log('WebSocket closed');
      if (mainWindow) {
        mainWindow.webContents.send('connection-status', 'disconnected');
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        log(`Failed to parse WS message: ${e.message}`);
      }
    };
  });
}

// ── Pending request map ──
const pendingRequests = new Map();

function handleWsMessage(msg) {
  if (msg.type === 'response' && msg.id && pendingRequests.has(msg.id)) {
    const { resolve } = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    resolve(msg);
  } else if (msg.type === 'pong') {
    log('Pong received');
  } else if (msg.type === 'error') {
    log(`Server error: ${msg.message}`);
  }
}

function sendWsRequest(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    if (!wsConnection || !isConnected) {
      reject(new Error('Not connected'));
      return;
    }

    const id = crypto.randomBytes(8).toString('hex');
    const msg = { type: 'request', id, method, path: pathname, headers: headers || {} };
    if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      msg.body = body;
    }

    pendingRequests.set(id, { resolve, reject });

    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);

    wsConnection.send(JSON.stringify(msg));
  });
}

// ── Local HTTP Proxy ──
function startProxyServer() {
  return new Promise((resolve, reject) => {
    proxyServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${proxyPort}`);
      const method = req.method;
      const pathname = url.pathname;

      // Collect request body
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf-8') || undefined;

        try {
          const response = await sendWsRequest(method, pathname, req.headers, body);
          const status = response.status || 200;
          const responseBody = response.body;
          const responseHeaders = response.headers || {};

          // Write response headers
          const outHeaders = { 'Access-Control-Allow-Origin': '*', ...responseHeaders };

          // For HTML responses, rewrite base URL
          if (typeof responseBody === 'string' && responseBody.includes('<html') || responseBody.includes('<!DOCTYPE')) {
            outHeaders['Content-Type'] = 'text/html; charset=utf-8';
          } else if (typeof responseBody === 'string') {
            outHeaders['Content-Type'] = 'text/plain; charset=utf-8';
          } else {
            outHeaders['Content-Type'] = 'application/json';
          }

          let outBody = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);

          // For static file proxy, headers may include content-type
          if (response.contentType) {
            outHeaders['Content-Type'] = response.contentType;
          }
          if (response.contentLength !== undefined) {
            outHeaders['Content-Length'] = response.contentLength;
          }

          res.writeHead(status, outHeaders);
          res.end(outBody);
        } catch (err) {
          log(`Proxy error for ${method} ${pathname}: ${err.message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
        }
      });
    });

    // Listen on a random port
    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port;
      log(`Local proxy server running on http://127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });

    proxyServer.on('error', reject);
  });
}

// ── IPC Handlers ──
function setupIPC() {
  ipcMain.handle('connect', async (event, { serverUrl, apiKey }) => {
    try {
      await connectWebSocket(serverUrl, apiKey);
      const port = await startProxyServer();
      return { success: true, proxyPort: port };
    } catch (err) {
      log(`Connection failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect', async () => {
    try {
      if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
      }
      if (proxyServer) {
        proxyServer.close();
        proxyServer = null;
      }
      isConnected = false;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-proxy-url', () => {
    if (proxyPort) return `http://127.0.0.1:${proxyPort}`;
    return null;
  });

  ipcMain.handle('send-ping', async () => {
    try {
      await sendWsRequest('GET', '/api/health', {}, null);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// ── Create Window ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Aion',
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Remove menu bar for cleaner look
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (wsConnection) wsConnection.close();
    if (proxyServer) proxyServer.close();
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ── App Lifecycle ──
app.whenReady().then(() => {
  setupIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
