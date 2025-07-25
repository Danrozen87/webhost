import { WebContainer } from '@webcontainer/api';

// Constants
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'https://vercel.app',
  'https://lovable.dev',
  // Add your production domains here
];

const MESSAGE_TYPES = {
  // Incoming
  PING: 'ping',
  MOUNT_FILES: 'mount_files',
  RUN_COMMAND: 'run_command',
  WRITE_FILE: 'write_file',
  READ_FILE: 'read_file',
  
  // Outgoing
  READY: 'ready',
  PONG: 'pong',
  COMMAND_OUTPUT: 'command_output',
  COMMAND_EXIT: 'command_exit',
  SERVER_READY: 'server_ready',
  FILE_CONTENT: 'file_content',
  ERROR: 'error',
  STATUS_UPDATE: 'status_update'
};

// State
let webcontainerInstance = null;
let currentProcess = null;
let serverUrl = null;

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
  // In development, allow all origins
  if (origin === 'null' || origin === 'file://') return true;
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
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
    
    updateStatus('WebContainer ready', 'ready');
    window.parent.postMessage({ type: 'ready' }, '*');
    
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
  [MESSAGE_TYPES.PING]: () => {
    sendMessage(MESSAGE_TYPES.PONG);
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
  // Security check
  if (!isAllowedOrigin(event.origin)) {
    console.warn('[Security] Rejected message from', event.origin);
    return;
  }
  
  const { type, payload } = event.data || {};
  console.log('[Received]', type, payload);
  
  const handler = messageHandlers[type];
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
  if (event.data === 'health-check') {
    event.source.postMessage({
      status: 'healthy',
      webcontainer: !!webcontainerInstance,
      serverUrl
    }, event.origin);
  }
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (currentProcess) {
    currentProcess.kill();
  }
  if (webcontainerInstance) {
    webcontainerInstance.teardown();
  }
});

// Initialize
initWebContainer();
