import { WebContainer } from '@webcontainer/api';

// Environment checks
const isInIframe = window.self !== window.top;
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

function sendMessage(type, payload = {}, targetOrigin = '*') {
  const message = {
    type,
    payload,
    timestamp: Date.now()
  };
  window.parent.postMessage(message, targetOrigin);
  console.log('[Sent]', type, payload);
}

function isAllowedOrigin(origin) {
  // Ignore self
  if (origin === selfOrigin) return false;
  
  // Allow null and file origins (for testing)
  if (origin === 'null' || origin === 'file://') return true;
  
  // List of allowed domain patterns
  const allowedDomains = [
    'localhost',
    'lovable',
    'vercel',
    'stackblitz',
    'webcontainer.io',
    'supabase.co',
    'supabase.com'
  ];
  
  // Check if origin contains any of the allowed domains
  return allowedDomains.some(domain => origin.includes(domain));
}

// Start heartbeat to establish connection
function startHeartbeat() {
  if (!isInIframe) {
    updateStatus('Not in iframe - open this URL in your app', 'ready');
    return;
  }
  
  let attempts = 0;
  
  heartbeatInterval = setInterval(() => {
    if (!connected) {
      attempts++;
      console.log(`[Heartbeat] Attempt ${attempts} - Broadcasting ready signal...`);
      
      // Try multiple message formats to ensure compatibility
      window.parent.postMessage({ type: 'ready' }, '*');
      window.parent.postMessage({ type: 'READY' }, '*');
      window.parent.postMessage('ready', '*');
      window.parent.postMessage({ 
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
    
    // Send initial ready message only if in iframe
    if (isInIframe) {
      window.parent.postMessage({ type: 'ready' }, '*');
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

// Message handlers
const messageHandlers = {
  'PING': () => {
    connected = true;
    clearInterval(heartbeatInterval);
    updateStatus('Connected! Responding to PING', 'ready');
    sendMessage(MESSAGE_TYPES.PONG);
  },
  
  'ping': () => {
    connected = true;
    clearInterval(heartbeatInterval);
    updateStatus('Connected! Responding to ping', 'ready');
    sendMessage('pong');
  },
  
  [MESSAGE_TYPES.MOUNT_FILES]: async ({ files }) => {
    try {
      updateStatus('Mounting files...', 'loading');
      await webcontainerInstance.mount(files);
      updateStatus('Files mounted', 'ready');
      sendMessage(MESSAGE_TYPES.STATUS_UPDATE, { status: 'files_mounted' });
    } catch (error) {
      console.error('[Mount Error]', error);
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'MOUNT_FAILED'
      });
    }
  },
  
  [MESSAGE_TYPES.RUN_COMMAND]: async ({ command, args = [] }) => {
    try {
      updateStatus(`Running: ${command} ${args.join(' ')}`, 'loading');
      
      // Kill previous process if exists
      if (currentProcess) {
        currentProcess.kill();
      }
      
      currentProcess = await webcontainerInstance.spawn(command, args);
      
      // Stream output
      currentProcess.output.pipeTo(new WritableStream({
        write(data) {
          sendMessage(MESSAGE_TYPES.COMMAND_OUTPUT, { data });
          console.log('[Output]', data);
        }
      }));
      
      // Wait for exit
      const exitCode = await currentProcess.exit;
      currentProcess = null;
      
      sendMessage(MESSAGE_TYPES.COMMAND_EXIT, { exitCode });
      
      if (exitCode === 0) {
        updateStatus('Command completed', 'ready');
      } else {
        updateStatus(`Command failed with exit code ${exitCode}`, 'error');
      }
      
    } catch (error) {
      console.error('[Command Error]', error);
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'COMMAND_FAILED'
      });
    }
  },
  
  [MESSAGE_TYPES.WRITE_FILE]: async ({ path, content }) => {
    try {
      await webcontainerInstance.fs.writeFile(path, content);
      sendMessage(MESSAGE_TYPES.STATUS_UPDATE, { 
        status: 'file_written',
        path 
      });
    } catch (error) {
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'WRITE_FAILED',
        path
      });
    }
  },
  
  [MESSAGE_TYPES.READ_FILE]: async ({ path }) => {
    try {
      const content = await webcontainerInstance.fs.readFile(path, 'utf8');
      sendMessage(MESSAGE_TYPES.FILE_CONTENT, { path, content });
    } catch (error) {
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'READ_FAILED',
        path
      });
    }
  }
};

// Message listener
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
  
  // Mark as connected on first valid message
  if (!connected && event.data && (event.data.type || typeof event.data === 'string')) {
    connected = true;
    clearInterval(heartbeatInterval);
    updateStatus('Connected to parent!', 'ready');
  }
  
  // Handle string messages
  if (typeof event.data === 'string') {
    if (event.data.toLowerCase() === 'ping') {
      messageHandlers['ping']();
      return;
    }
  }
  
  const { type, payload } = event.data || {};
  
  const handler = messageHandlers[type] || messageHandlers[type?.toLowerCase()];
  if (handler) {
    try {
      await handler(payload);
    } catch (error) {
      console.error('[Handler Error]', error);
      sendMessage(MESSAGE_TYPES.ERROR, { 
        message: error.message,
        code: 'HANDLER_ERROR',
        type
      });
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
  if (currentProcess) {
    currentProcess.kill();
  }
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
  }
});

// Initialize
initWebContainer();
