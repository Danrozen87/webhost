import { WebContainer } from '@webcontainer/api';

// Environment checks
const isInIframe = window.self !== window.top;
const isInPopup = !!window.opener;
const isEmbedded = isInIframe || isInPopup;
const selfOrigin = window.location.origin;

// Constants
const MESSAGE_TYPES = {
  // Incoming
  PING: 'PING',
  MOUNT_FILES: 'MOUNT_FILES',
  RUN_COMMAND: 'RUN_COMMAND',
  WRITE_FILE: 'WRITE_FILE',
  READ_FILE: 'READ_FILE',
  
  // Outgoing
  READY: 'READY',
  PONG: 'PONG',
  COMMAND_OUTPUT: 'COMMAND_OUTPUT',
  COMMAND_EXIT: 'COMMAND_EXIT',
  SERVER_READY: 'SERVER_READY',
  FILE_CONTENT: 'FILE_CONTENT',
  ERROR: 'ERROR',
  STATUS_UPDATE: 'STATUS_UPDATE'
};

// State
let webcontainerInstance = null;
let currentProcess = null;
let devServerProcess = null;
let installProcess = null;
let serverUrl = null;
let connected = false;
let heartbeatInterval = null;

// DOM elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const loadingOverlay = document.getElementById('loading-overlay');
const previewFrame = document.getElementById('preview-frame');

// Helper functions
function updateStatus(status, type = 'loading') {
  statusText.textContent = status;
  statusIndicator.className = `status-indicator ${type}`;
  console.log(`[Status] ${status}`);
}

function showError(message) {
  updateStatus(`Error: ${message}`, 'error');
  loadingOverlay.innerHTML = `<div class="error-message">${message}</div>`;
  loadingOverlay.classList.remove('hidden');
}

function sendMessage(type, payload = {}, targetOrigin = '*', messageId = null) {
  const message = {
    type,
    payload,
    timestamp: Date.now()
  };
  
  // Add ID for response messages
  if (messageId) {
    message.id = messageId;
  }
  
  // Send to parent (iframe) or opener (popup)
  const target = window.opener || window.parent;
  target.postMessage(message, targetOrigin);
  console.log('[Sent]', type, messageId ? `(ID: ${messageId})` : '', payload);
}

function isAllowedOrigin(origin) {
  // Ignore self
  if (origin === selfOrigin) return false;
  
  // Allow null and file origins (for testing)
  if (origin === 'null' || origin === 'file://') return true;
  
  // Specific allowlist
  const allowedPatterns = [
    'localhost',
    'lovable.dev',
    'https://7f818ebb-e5cc-4179-8f6c-e01617c5204a.lovableproject.com',
    'lovableproject.com',  // This is the key one!
    'vercel.app',
    'stackblitz.io',
    'stackblitz.com',
    'webcontainer.io'
  ];
  
  return allowedPatterns.some(pattern => origin.includes(pattern));
}

// Kill all running processes
async function killAllProcesses() {
  const processes = [currentProcess, devServerProcess, installProcess];
  
  for (const process of processes) {
    if (process) {
      try {
        process.kill();
        console.log('[Process] Killed process');
      } catch (e) {
        console.warn('[Process] Error killing process:', e);
      }
    }
  }
  
  currentProcess = null;
  devServerProcess = null;
  installProcess = null;
}

// Start heartbeat to establish connection
function startHeartbeat() {
  if (!isEmbedded) {
    updateStatus('Not in iframe or popup - open this URL in your app', 'error');
    return;
  }
  
  let attempts = 0;
  
  heartbeatInterval = setInterval(() => {
    if (!connected) {
      attempts++;
      console.log(`[Heartbeat] Attempt ${attempts} - Broadcasting ready signal...`);
      
      // Send to parent or opener
      const target = window.opener || window.parent;
      
      // Try multiple message formats to ensure compatibility
      target.postMessage({ type: 'ready' }, '*');
      target.postMessage({ type: 'READY' }, '*');
      target.postMessage('ready', '*');
      target.postMessage({ 
        type: 'WEBCONTAINER_READY',
        status: 'ready',
        timestamp: Date.now() 
      }, '*');
      
      updateStatus(`Waiting for connection... (attempt ${attempts})`, 'loading');
    }
  }, 1000); // Send every second
}

// WebContainer initialization
async function initWebContainer() {
  try {
    updateStatus('Booting WebContainer...', 'loading');
    
    webcontainerInstance = await WebContainer.boot({
      coep: 'require-corp',
      workdirName: 'project',
      forwardPreviewErrors: true
    });
    
    updateStatus('WebContainer ready - Waiting for parent...', 'ready');
    
    // Send initial ready message only if embedded
    if (isEmbedded) {
      const target = window.opener || window.parent;
      target.postMessage({ type: 'ready' }, '*');
    }
    
    // Start heartbeat
    startHeartbeat();
    
    // Set up server ready listener
    webcontainerInstance.on('server-ready', (port, url) => {
      console.log('[Server Ready]', { port, url });
      serverUrl = url;
      
      // Show preview
      previewFrame.src = url;
      previewFrame.style.display = 'block';
      loadingOverlay.classList.add('hidden');
      
      updateStatus(`Server running on port ${port}`, 'ready');
      sendMessage(MESSAGE_TYPES.SERVER_READY, { port, url });
    });
    
    // Set up error handling
    webcontainerInstance.on('error', (error) => {
      console.error('[WebContainer Error]', error);
      showError(error.message);
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'WEBCONTAINER_ERROR'
      });
    });
    
  } catch (error) {
    console.error('[Boot Error]', error);
    showError(`Failed to boot WebContainer: ${error.message}`);
    sendMessage(MESSAGE_TYPES.ERROR, { 
      message: error.message,
      code: 'BOOT_FAILED'
    });
  }
}

// Check if package.json exists
async function hasPackageJson() {
  try {
    await webcontainerInstance.fs.readFile('/package.json', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Get the dev command from package.json
async function getDevCommand() {
  try {
    const packageJson = await webcontainerInstance.fs.readFile('/package.json', 'utf8');
    const pkg = JSON.parse(packageJson);
    
    // Check for common dev scripts
    const scripts = pkg.scripts || {};
    if (scripts.dev) return 'dev';
    if (scripts.start) return 'start';
    if (scripts.serve) return 'serve';
    
    // Default to dev
    return 'dev';
  } catch {
    return 'dev';
  }
}

// Message listener with proper ID handling
window.addEventListener('message', async (event) => {
  // Ignore messages from self
  if (event.origin === selfOrigin) {
    console.log('[Ignored] Message from self');
    return;
  }
  
  // Log ALL external messages
  console.log('[Received from]', event.origin, ':', event.data);
  
  // Security check
  if (!isAllowedOrigin(event.origin)) {
    console.warn('[Security] Rejected message from', event.origin);
    return;
  }
  
  const message = event.data || {};
  const { type, payload, id, timestamp } = message;
  
  // CRITICAL: Handle PING with proper response
  if (type === 'PING' || type === 'ping') {
    connected = true;
    clearInterval(heartbeatInterval);
    updateStatus('Connected! Responding to PING', 'ready');
    
    // Send PONG with same ID if provided
    if (id) {
      sendMessage('PONG', { timestamp: Date.now() }, event.origin, id);
    } else {
      sendMessage('PONG', { timestamp: Date.now() }, event.origin);
    }
    return;
  }
  
  // Handle other message types with proper responses
  try {
    let responsePayload = null;
    
    switch (type) {
      case MESSAGE_TYPES.MOUNT_FILES:
        responsePayload = await handleMountFiles(payload);
        break;
        
      case MESSAGE_TYPES.WRITE_FILE:
        responsePayload = await handleWriteFile(payload);
        break;
        
      case MESSAGE_TYPES.READ_FILE:
        responsePayload = await handleReadFile(payload);
        break;
        
      default:
        console.log('[Unknown Message Type]', type);
        return;
    }
    
    // Send response with same ID
    if (id && responsePayload) {
      sendMessage('SUCCESS', responsePayload, event.origin, id);
    }
    
  } catch (error) {
    console.error('[Handler Error]', error);
    
    // Send error response with same ID
    if (id) {
      sendMessage('ERROR', { 
        error: error.message,
        code: 'HANDLER_ERROR',
        type 
      }, event.origin, id);
    }
  }
});

// Health check endpoint
window.addEventListener('message', (event) => {
  if (event.origin === selfOrigin) return;
  
  if (event.data === 'health-check') {
    event.source.postMessage({
      status: 'healthy',
      webcontainer: !!webcontainerInstance,
      serverUrl,
      connected
    }, event.origin);
  }
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  // Kill all processes
  killAllProcesses();
  
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
  }
});

// Separate handler functions that return responses
async function handleMountFiles(payload) {
  const { files } = payload;
  
  // Kill any existing processes
  await killAllProcesses();
  
  // Reset preview
  previewFrame.src = 'about:blank';
  previewFrame.style.display = 'none';
  loadingOverlay.classList.remove('hidden');
  
  // 1. Mount files
  updateStatus('Mounting project files...', 'loading');
  await webcontainerInstance.mount(files);
  
  // Send broadcast status update (separate from response)
  sendMessage(MESSAGE_TYPES.STATUS_UPDATE, { 
    status: 'files_mounted',
    message: 'Project files mounted successfully'
  });
  
  // Check if we need to install dependencies
  const hasPackage = await hasPackageJson();
  
  if (hasPackage) {
    // Install and start server (async, don't wait)
    installAndStartServer();
  } else {
    updateStatus('Project mounted (no package.json found)', 'ready');
  }
  
  return { status: 'mounted', hasPackage };
}

async function installAndStartServer() {
  try {
    // 2. Install dependencies
    updateStatus('Installing dependencies...', 'loading');
    
    installProcess = await webcontainerInstance.spawn('npm', ['install']);
    
    installProcess.output.pipeTo(new WritableStream({
      write(data) {
        console.log('[npm install]', data);
        sendMessage(MESSAGE_TYPES.COMMAND_OUTPUT, { 
          command: 'npm install',
          data 
        });
      }
    }));
    
    const installExitCode = await installProcess.exit;
    installProcess = null;
    
    if (installExitCode !== 0) {
      throw new Error(`npm install failed with exit code ${installExitCode}`);
    }
    
    // 3. Start dev server
    updateStatus('Starting development server...', 'loading');
    
    const devCommand = await getDevCommand();
    devServerProcess = await webcontainerInstance.spawn('npm', ['run', devCommand]);
    
    devServerProcess.output.pipeTo(new WritableStream({
      write(data) {
        console.log('[dev server]', data);
        sendMessage(MESSAGE_TYPES.COMMAND_OUTPUT, { 
          command: `npm run ${devCommand}`,
          data 
        });
      }
    }));
    
  } catch (error) {
    console.error('[Install/Start Error]', error);
    updateStatus(`Failed: ${error.message}`, 'error');
    sendMessage(MESSAGE_TYPES.ERROR, { 
      message: error.message,
      code: 'INSTALL_START_FAILED'
    });
  }
}

async function handleWriteFile(payload) {
  const { path, content } = payload;
  await webcontainerInstance.fs.writeFile(path, content);
  console.log(`[File Written] ${path}`);
  return { path, status: 'written' };
}

async function handleReadFile(payload) {
  const { path } = payload;
  const content = await webcontainerInstance.fs.readFile(path, 'utf8');
  return { path, content };
}

// Initialize
initWebContainer();
