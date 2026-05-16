// ─────────────────────────────────────────────────────────────────────────────
// FlashForge IDE — Frontend (Web Serial API + optional local backend)
// ─────────────────────────────────────────────────────────────────────────────

// Always connect to the cloud/local backend.
// Set via Settings button, stored in localStorage.
const DEFAULT_BACKEND = 'http://localhost:3000';
let BACKEND = localStorage.getItem('kurunotchi_backend') || DEFAULT_BACKEND;
const WEB_SERIAL = 'serial' in navigator;

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab   = 'main';
let currentPanel = 'output';
let files        = { main: EXAMPLES.blink, config: CONFIG_H };
let fontSize     = 13.5;
let isConnected  = false;
let logCount     = 0;
let backendOnline = false;

// Web Serial state
let serialPort   = null;
let serialReader = null;
let serialStreamClosed = null;

const editor   = document.getElementById('codeEditor');
const lineNums = document.getElementById('lineNumbers');
let   cmEditor = null;   // CodeMirror instance

// ── esptool-js: loaded on-demand via dynamic import ──────────────────────────
let _esptoolCache = null;
async function loadEsptool() {
  if (_esptoolCache) return _esptoolCache;
  addLog('info', 'Loading esptool-js...');
  const mod = await import('https://unpkg.com/esptool-js@0.4.6/bundle.js');
  _esptoolCache = { Transport: mod.Transport, ESPLoader: mod.ESPLoader };
  return _esptoolCache;
}

// ── Helpers: get / set code via CodeMirror (or fallback to textarea) ─────────
function getCode()         { return cmEditor ? cmEditor.getValue() : editor.value; }
function setCode(code)     { if (cmEditor) cmEditor.setValue(code); else editor.value = code; }
function setCodeSilent(code) {
  // set without firing onChange (used when switching tabs)
  if (cmEditor) { cmEditor.setValue(code); } else { editor.value = code; }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  initCodeMirror();
  updateStatusChars();
  checkBackend();
  loadGrantedPorts();
}

function initCodeMirror() {
  cmEditor = CodeMirror.fromTextArea(editor, {
    mode: 'text/x-c++src',
    lineNumbers: true,
    tabSize: 2,
    indentWithTabs: false,
    indentUnit: 2,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    lineWrapping: false,
    theme: 'default',
    extraKeys: {
      'Ctrl-R':       () => verifyCode(),
      'Ctrl-Shift-U': () => uploadCode(),
      'Ctrl-Shift-F': () => formatCode(),
      'Ctrl-/':       (cm) => cm.execCommand('toggleComment'),
      'Tab':          (cm) => cm.execCommand('indentMore'),
      'Shift-Tab':    (cm) => cm.execCommand('indentLess'),
    },
  });

  // Populate with current file
  cmEditor.setValue(files.main);

  cmEditor.on('change', () => {
    files[currentTab] = cmEditor.getValue();
    updateStatusChars();
  });

  cmEditor.on('cursorActivity', () => {
    const cur = cmEditor.getCursor();
    document.getElementById('cursorPos').textContent =
      `Ln ${cur.line + 1}, Col ${cur.ch + 1}`;
  });

  // Apply current font size
  cmEditor.getWrapperElement().style.fontSize = fontSize + 'px';
}

// ── Backend check ───────────────────────────────────────────────────────────────────
async function checkBackend() {
  try {
    const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(6000) });
    backendOnline = res.ok;
  } catch {
    backendOnline = false;
  }
  if (backendOnline) {
    addLog('success', `\u2713 Backend connected: ${BACKEND}`);
  } else {
    if (WEB_SERIAL) {
      addLog('success', '\u2713 Web Serial API ready \u2014 click \ud83d\udd0c Connect to select your port');
      addLog('info', '\u2139 Compile/Upload: click \u2699 Settings to enter your Railway/Render backend URL.');
    } else {
      addLog('warn', '\u26a0 Use Chrome or Edge 89+ for Web Serial port access');
    }
  }
  setTimeout(checkBackend, 15000);
}

// ── Web Serial: load previously granted ports ────────────────────────────────
async function loadGrantedPorts() {
  if (!WEB_SERIAL) return;
  const ports = await navigator.serial.getPorts();
  if (ports.length > 0) {
    addLog('info', `${ports.length} previously authorized port(s) available — click 🔌 Connect`);
  }
}

// ── Connect port (Web Serial picker) ─────────────────────────────────────────
async function connectPort() {
  if (!WEB_SERIAL) {
    addLog('error', '⚠ Web Serial API not supported. Use Chrome or Edge 89+.');
    return;
  }
  if (isConnected) { await disconnectPort(); return; }

  try {
    serialPort = await navigator.serial.requestPort();
  } catch (e) {
    if (e.name !== 'NotFoundError') addLog('error', `Port picker error: ${e.message}`);
    return;
  }
  await openPort();
}

async function openPort() {
  if (!serialPort) return;
  const baud = parseInt(document.getElementById('baudRate').value, 10);
  try {
    await serialPort.open({ baudRate: baud });
  } catch (e) {
    addLog('error', `Could not open port: ${e.message}`);
    serialPort = null;
    return;
  }

  isConnected = true;
  document.getElementById('portDot').className = 'port-dot connected';
  document.getElementById('portLabel').textContent = 'Connected';
  document.getElementById('portConnectBtn').style.display = 'none';
  document.getElementById('portDisconnectBtn').style.display = '';
  document.getElementById('statusPort').textContent = '● Serial';
  document.getElementById('serialInputRow').style.display = 'flex';
  switchPanel('serial');
  appendSerial(`<span style="color:var(--green)">✓ Serial connected @ ${baud} baud</span>`);
  addLog('success', `Serial port opened @ ${baud} baud`);

  startReading();
}

async function startReading() {
  try {
    const decoder = new TextDecoderStream();
    serialStreamClosed = serialPort.readable.pipeTo(decoder.writable);
    serialReader = decoder.readable.getReader();
    while (true) {
      const { value, done } = await serialReader.read();
      if (done) break;
      if (value) appendSerial(escapeHtml(value));
    }
  } catch (e) {
    if (!['AbortError','NetworkError','TypeError'].includes(e.name)) {
      appendSerial(`<span style="color:var(--red)">Read error: ${e.message}</span>`);
    }
  }
}

async function disconnectPort() {
  try {
    if (serialReader) { await serialReader.cancel(); serialReader = null; }
    if (serialStreamClosed) { try { await serialStreamClosed; } catch {} serialStreamClosed = null; }
    if (serialPort) { try { await serialPort.close(); } catch {} serialPort = null; }
  } catch {}

  isConnected = false;
  document.getElementById('portDot').className = 'port-dot';
  document.getElementById('portLabel').textContent = 'No port';
  document.getElementById('portConnectBtn').style.display = '';
  document.getElementById('portDisconnectBtn').style.display = 'none';
  document.getElementById('statusPort').textContent = '⊖ No Port';
  document.getElementById('serialInputRow').style.display = 'none';
  appendSerial('<span style="color:var(--text3)">Disconnected.</span>');
}

// ── Serial send ───────────────────────────────────────────────────────────────
async function sendSerial() {
  const input = document.getElementById('serialInput');
  const val   = input.value.trim();
  if (!val) return;

  if (isConnected && serialPort?.writable) {
    const writer = serialPort.writable.getWriter();
    await writer.write(new TextEncoder().encode(val + '\n'));
    writer.releaseLock();
  }
  appendSerial(`<span style="color:var(--accent2)">→ ${escapeHtml(val)}</span>`);
  input.value = '';
}

// ── Serial helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Convert ArrayBuffer → base64 in 8KB chunks to avoid call stack overflow
// btoa(String.fromCharCode(...hugeArray)) crashes for firmware > ~200KB
function arrayBufferToBase64(buffer) {
  const bytes     = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function appendSerial(html) {
  const out = document.getElementById('serialOutput');
  out.innerHTML += html + '\n';
  out.scrollTop = out.scrollHeight;
}

// ── Baud rate change ──────────────────────────────────────────────────────────
document.getElementById('baudRate').addEventListener('change', async function() {
  if (isConnected) {
    addLog('info', `Changing baud to ${this.value} — reconnecting...`);
    await disconnectPort();
    await openPort();
  }
});

// ── Flash .bin (esptool-js, ESP32 only, no backend needed) ───────────────────
async function flashBinFile() {
  if (!WEB_SERIAL) {
    addLog('error', '⚠ Web Serial required for Flash .bin — use Chrome/Edge 89+');
    return;
  }

  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.bin';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Close existing serial connection so esptool can access the port
    if (isConnected) await disconnectPort();

    let port = serialPort;
    if (!port) {
      try { port = await navigator.serial.requestPort(); }
      catch { addLog('error', 'No port selected for flashing.'); return; }
    }

    showUploadOverlay('Flashing .bin...', `Writing ${file.name}`);
    addLog('info', `Flashing ${file.name} (${(file.size/1024).toFixed(1)} KB)...`);
    switchPanel('output');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileContent = arrayBufferToBase64(arrayBuffer);

      const { Transport, ESPLoader } = await loadEsptool();
      const transport = new Transport(port, true);
      const loader = new ESPLoader({
        transport,
        baudrate: 921600,
        terminal: {
          clean:     ()  => {},
          writeLine: (d) => addLog('info', d.trim()),
          write:     (d) => { if (d.trim()) addLog('info', d.trim()); },
        },
        enableTracing: false,
      });

      addLog('info', 'Connecting to ESP32...');
      const chip = await loader.main();
      addLog('success', `✓ Chip detected: ${chip}`);

      await loader.writeFlash({
        fileArray:  [{ data: fileContent, address: 0x0 }],
        flashSize:  'keep',
        flashMode:  'keep',
        flashFreq:  'keep',
        eraseAll:   false,
        compress:   true,
        reportProgress(idx, written, total) {
          const pct = Math.round((written / total) * 100);
          document.getElementById('progressBar').style.width  = pct + '%';
          document.getElementById('progressLabel').textContent = pct + '%';
        },
      });

      await loader.after();
      await transport.disconnect();

      hideUploadOverlay(true, 'Flash Complete!', 'ESP32 is running your firmware');
      addLog('success', '✓ Flash successful!');

      // Reopen serial monitor
      serialPort = port;
      setTimeout(openPort, 1500);

    } catch (err) {
      hideUploadOverlay(false, 'Flash Failed', err.message);
      addLog('error', `Flash error: ${err.message}`);
    }
  };
  input.click();
}

// ── Verify (needs backend) ────────────────────────────────────────────────
async function verifyCode() {
  if (!backendOnline) {
    addLog('error', `⚠ Backend not reachable at: ${BACKEND}`);
    addLog('info', 'Click ⚙ Settings and make sure the URL starts with https://');
    return;
  }
  const btn   = document.getElementById('verifyBtn');
  const bar   = document.getElementById('verifyBar');
  const ready = document.getElementById('statusReady');
  const board = document.getElementById('boardSelect').value;

  btn.textContent = '⏳ Verifying...';
  btn.classList.add('loading');
  bar.classList.add('active');
  ready.textContent = 'COMPILING...';
  switchPanel('output');
  addLog('info', '─── Compiling ───');

  try {
    const res  = await fetch(`${BACKEND}/api/compile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: getCode(), board }),
    });
    const data = await res.json();
    data.output.split('\n').filter(Boolean).forEach(line => {
      if (/error:/i.test(line)) addLog('error', line);
      else if (/warn:/i.test(line)) addLog('warn', line);
      else addLog('info', line);
    });
    if (data.success) {
      addLog('success', '✓ Compilation successful.');
      document.getElementById('errorCount').style.display = 'none';
      ready.textContent = 'READY';
    } else {
      addLog('error', '✗ Compilation failed.');
      document.getElementById('errorCount').style.display = 'inline';
      document.getElementById('errorCount').textContent = '!';
      ready.textContent = 'ERROR';
    }
  } catch (e) { addLog('error', `Backend error: ${e.message}`); ready.textContent = 'ERROR'; }

  btn.textContent = '▶ Verify';
  btn.classList.remove('loading');
  bar.classList.remove('active');
}

// ── Upload (needs backend — backend runs arduino-cli) ────────────────────────
// ── Upload: compile on backend → flash via esptool-js (ESP32) ─────────────────────
async function uploadCode() {
  const ready     = document.getElementById('statusReady');
  const uploadBtn = document.getElementById('uploadBtn');
  const board     = document.getElementById('boardSelect').value;

  if (!backendOnline) {
    addLog('error', `⚠ Backend not reachable at ${BACKEND}`);
    addLog('info', 'Click ⚙ Settings to set your backend URL, or use ⚡ Flash .bin.');
    return;
  }
  if (!WEB_SERIAL) {
    addLog('error', '⚠ Web Serial API required — use Chrome or Edge 89+');
    return;
  }

  // Connect port if not already
  if (!serialPort) {
    try { serialPort = await navigator.serial.requestPort(); }
    catch { addLog('error', 'No port selected.'); return; }
  }

  uploadBtn.classList.add('loading');
  uploadBtn.textContent = '⏳ Compiling...';
  ready.textContent = 'COMPILING...';
  showUploadOverlay('Compiling...', `Building for ${document.getElementById('boardSelect').options[document.getElementById('boardSelect').selectedIndex].text}`);
  setAllSteps(''); setStep(1,'active');
  switchPanel('output');
  addLog('info', '─── Compile + Flash ───');

  // Step 1: Compile and get binary
  let binBuffer;
  let compileLog = '';
  try {
    addLog('info', 'Compiling on backend...');
    const res = await fetch(`${BACKEND}/api/compile-bin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: getCode(), board }),
    });

    if (!res.ok) {
      const err = await res.json();
      compileLog = err.output || err.error || 'Unknown compile error';
      compileLog.split('\n').filter(Boolean).forEach(l => addLog(/error:/i.test(l)?'error':'warn', l));
      throw new Error('Compilation failed');
    }

    // Show compile log from header
    const logB64 = res.headers.get('X-Compile-Output');
    if (logB64) {
      atob(logB64).split('\n').filter(Boolean).forEach(l => {
        if (/error:/i.test(l)) addLog('error', l);
        else if (/warn:/i.test(l)) addLog('warn', l);
        else addLog('info', l);
      });
    }

    binBuffer = await res.arrayBuffer();
    addLog('success', `✓ Compiled (${(binBuffer.byteLength/1024).toFixed(1)} KB)`);

  } catch (err) {
    hideUploadOverlay(false, 'Compile Failed', err.message);
    uploadBtn.classList.remove('loading'); uploadBtn.textContent = '⚡ Upload'; ready.textContent = 'ERROR';
    return;
  }

  setStep(1,'done'); setStep(2,'active');
  document.getElementById('progressBar').style.width = '30%';
  document.getElementById('progressLabel').textContent = '30%';

  // Step 2: Flash via esptool-js (ESP32 only)
  const isESP = ['esp32','esp32s3','esp32c3','esp32s2','wemos','nodemcu'].includes(board);
  if (!isESP) {
    hideUploadOverlay(false, 'AVR Flash Coming Soon', 'Use Arduino IDE for Uno/Nano/Mega upload for now');
    addLog('warn', '⚠ esptool-js only supports ESP32/ESP8266. For AVR, use Arduino IDE or the local node server.js backend.');
    uploadBtn.classList.remove('loading'); uploadBtn.textContent = '⚡ Upload'; ready.textContent = 'READY';
    return;
  }

  uploadBtn.textContent = '⏳ Flashing...';
  ready.textContent = 'FLASHING...';
  showUploadOverlay('Flashing...', 'Writing firmware to device');
  setStep(2,'done'); setStep(3,'active');

  try {
    // Save port reference BEFORE disconnectPort() nulls serialPort
    const flashPort = serialPort;
    if (!flashPort) { throw new Error('No serial port selected. Click 🔌 Connect first.'); }
    if (isConnected) await disconnectPort();

    const fileContent = arrayBufferToBase64(binBuffer);
    const { Transport, ESPLoader } = await loadEsptool();
    const transport   = new Transport(flashPort, true);
    const loader      = new ESPLoader({
      transport,
      baudrate: 921600,
      terminal: {
        clean:     ()  => {},
        writeLine: (d) => { if (d.trim()) addLog('info', d.trim()); },
        write:     (d) => { if (d.trim()) addLog('info', d.trim()); },
      },
      enableTracing: false,
    });

    addLog('info', 'Connecting to chip...');
    const chip = await loader.main();
    addLog('success', `✓ Connected: ${chip}`);

    setStep(3,'done'); setStep(4,'active');
    document.getElementById('progressBar').style.width = '55%';
    document.getElementById('progressLabel').textContent = '55%';

    await loader.writeFlash({
      fileArray:  [{ data: fileContent, address: 0x0 }],
      flashSize:  'keep', flashMode: 'keep', flashFreq: 'keep',
      eraseAll:   false, compress: true,
      reportProgress(idx, written, total) {
        const pct = Math.round(55 + (written / total) * 40);
        document.getElementById('progressBar').style.width  = pct + '%';
        document.getElementById('progressLabel').textContent = pct + '%';
      },
    });

    setStep(4,'done'); setStep(5,'active');
    await loader.after();
    await transport.disconnect();
    setStep(5,'done');

    document.getElementById('progressBar').style.width = '100%';
    document.getElementById('progressLabel').textContent = '100%';
    hideUploadOverlay(true, 'Upload Complete!', 'Device is running your code');
    addLog('success', '✓ Flash successful! Device is running.');
    uploadBtn.classList.remove('loading'); uploadBtn.textContent = '⚡ Upload'; ready.textContent = 'READY';
    serialPort = flashPort; // restore so openPort() can reconnect serial monitor
    setTimeout(openPort, 1500);

  } catch (err) {
    hideUploadOverlay(false, 'Flash Failed', err.message);
    addLog('error', `Flash error: ${err.message}`);
    uploadBtn.classList.remove('loading'); uploadBtn.textContent = '⚡ Upload'; ready.textContent = 'ERROR';
  }
}

// ── Backend URL settings ─────────────────────────────────────────────────────
function openSettings() {
  const current = localStorage.getItem('kurunotchi_backend') || DEFAULT_BACKEND;
  const url = prompt(
    'Enter backend URL:\n(e.g. https://your-app.up.railway.app  or  http://localhost:3000)\nMust start with https:// or http://',
    current
  );
  if (url === null) return;

  let trimmed = url.trim().replace(/\/$/, '');
  // Auto-fix missing protocol
  if (trimmed && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = 'https://' + trimmed;
  }
  BACKEND = trimmed || DEFAULT_BACKEND;
  localStorage.setItem('kurunotchi_backend', BACKEND);
  addLog('info', `Backend URL set to: ${BACKEND}`);
  addLog('info', 'Testing connection...');
  backendOnline = false;
  checkBackend();
}



// ── Upload overlay helpers ────────────────────────────────────────────────────
function showUploadOverlay(title, sub) {
  document.getElementById('uploadTitle').textContent = title;
  document.getElementById('uploadSub').textContent   = sub;
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressLabel').textContent = '0%';
  document.getElementById('uploadOverlay').classList.add('show');
}
function hideUploadOverlay(success, title, sub) {
  document.getElementById('uploadTitle').textContent = title;
  document.getElementById('uploadSub').textContent   = sub;
  setTimeout(() => document.getElementById('uploadOverlay').classList.remove('show'), 1800);
}
function setStep(n, state) {
  document.getElementById('dot'+n).className  = 'step-dot '+ state;
  document.getElementById('step'+n).className = 'upload-step '+ state;
}
function setAllSteps(state) { [1,2,3,4,5].forEach(i => setStep(i, state)); }

// ── Line numbers ──────────────────────────────────────────────────────────────
function updateLineNumbers() {
  const lines   = editor.value.split('\n');
  const curLine = editor.value.substr(0, editor.selectionStart).split('\n').length;
  lineNums.innerHTML = lines.map((_, i) =>
    `<div class="line-num${i+1===curLine?' current':''}">${i+1}</div>`
  ).join('');
}
function syncScroll() { lineNums.scrollTop = editor.scrollTop; }
function onEditorInput() { files[currentTab]=editor.value; updateLineNumbers(); updateStatusChars(); }
function updateStatusChars() { document.getElementById('statusChars').textContent = getCode().length+' chars'; }
function updateCursor() {
  const lines = editor.value.substr(0, editor.selectionStart).split('\n');
  document.getElementById('cursorPos').textContent = `Ln ${lines.length}, Col ${lines[lines.length-1].length+1}`;
  updateLineNumbers();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function handleKeydown(e) {
  if (e.key==='Tab') {
    e.preventDefault();
    const s=editor.selectionStart, end=editor.selectionEnd;
    editor.value=editor.value.substring(0,s)+'  '+editor.value.substring(end);
    editor.selectionStart=editor.selectionEnd=s+2; onEditorInput();
  }
  if (e.ctrlKey&&e.key==='r')                 { e.preventDefault(); verifyCode(); }
  if (e.ctrlKey&&e.shiftKey&&e.key==='U')     { e.preventDefault(); uploadCode(); }
  if (e.ctrlKey&&e.shiftKey&&e.key==='F')     { e.preventDefault(); formatCode(); }
}

// ── File tabs ─────────────────────────────────────────────────────────────────
function switchTab(tab) {
  files[currentTab] = getCode();
  currentTab = tab;
  setCodeSilent(files[tab] || '');
  updateStatusChars();
  document.getElementById('tab-main').style.color   = tab==='main'   ? 'var(--accent)' : '';
  document.getElementById('tab-config').style.color = tab==='config' ? 'var(--accent)' : '';
  if (cmEditor) cmEditor.focus();
}

// ── Panel tabs ────────────────────────────────────────────────────────────────
function switchPanel(panel) {
  currentPanel=panel;
  ['output','serial','errors'].forEach(p => {
    document.getElementById(p+'Panel').style.display = p===panel?'flex':'none';
    document.getElementById('tab-'+p).classList.toggle('active', p===panel);
  });
  document.getElementById('serialInputRow').style.display =
    (panel==='serial' && isConnected) ? 'flex' : 'none';
}

// ── Logging ───────────────────────────────────────────────────────────────────
function getTime() {
  const n=new Date();
  return `${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
}
function addLog(type, msg) {
  const out=document.getElementById('outputPanel');
  const d=document.createElement('div'); d.className='log-line';
  d.innerHTML=`<span class="log-time">[${getTime()}]</span><span class="log-${type}">${msg}</span>`;
  out.appendChild(d); out.scrollTop=out.scrollHeight; logCount++;
}
function clearOutput() {
  document.getElementById('outputPanel').innerHTML='';
  document.getElementById('serialOutput').innerHTML=''; logCount=0;
}

// ── Examples ──────────────────────────────────────────────────────────────────
function toggleDropdown() { document.getElementById('ddMenu').classList.toggle('open'); }
document.addEventListener('click', e => {
  if (!document.getElementById('examplesDD').contains(e.target))
    document.getElementById('ddMenu').classList.remove('open');
});
function loadExample(name) {
  files.main = EXAMPLES[name] || files.main;
  if (currentTab === 'main') setCode(files.main);
  document.getElementById('ddMenu').classList.remove('open');
  addLog('info', `Loaded example: ${name}`);
  if (cmEditor) cmEditor.focus();
}
function newFile() {
  const name=prompt('New file name (e.g. helper.h):');
  if (name) addLog('info',`File "${name}" created (feature coming soon)`);
}

// ── Board select ──────────────────────────────────────────────────────────────
const BOARD_INFO = {
  esp32:    {label:'32', chip:'ESP32 • Xtensa LX6',        cls:'chip-esp', info:'CPU: Xtensa LX6<br>Flash: 4MB<br>SRAM: 520KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: 4.2/5.0'},
  esp32s3:  {label:'S3', chip:'ESP32-S3 • Xtensa LX7',     cls:'chip-esp', info:'CPU: Xtensa LX7<br>Flash: 8MB<br>SRAM: 512KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: 5.0'},
  esp32c3:  {label:'C3', chip:'ESP32-C3 • RISC-V',         cls:'chip-esp', info:'CPU: RISC-V 32-bit<br>Flash: 4MB<br>SRAM: 400KB<br>Speed: 160MHz<br>WiFi: 802.11 b/g/n<br>BLE: 5.0'},
  esp32s2:  {label:'S2', chip:'ESP32-S2 • Xtensa LX7',     cls:'chip-esp', info:'CPU: Xtensa LX7<br>Flash: 4MB<br>SRAM: 320KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: No'},
  uno:      {label:'Ω',  chip:'Arduino Uno • ATmega328P',  cls:'chip-avr', info:'CPU: ATmega328P<br>Flash: 32KB<br>SRAM: 2KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No'},
  nano:     {label:'N',  chip:'Arduino Nano • ATmega328P', cls:'chip-avr', info:'CPU: ATmega328P<br>Flash: 32KB<br>SRAM: 2KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No'},
  mega:     {label:'M',  chip:'Mega 2560 • ATmega2560',    cls:'chip-avr', info:'CPU: ATmega2560<br>Flash: 256KB<br>SRAM: 8KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No'},
  leonardo: {label:'L',  chip:'Leonardo • ATmega32u4',     cls:'chip-avr', info:'CPU: ATmega32u4<br>Flash: 32KB<br>SRAM: 2.5KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No'},
  mkr:      {label:'M',  chip:'MKR WiFi 1010 • SAMD21',   cls:'chip-avr', info:'CPU: ARM Cortex-M0+<br>Flash: 256KB<br>SRAM: 32KB<br>Speed: 48MHz<br>WiFi: 802.11 b/g/n<br>BLE: 4.2'},
  wemos:    {label:'8',  chip:'Wemos D1 • ESP8266',        cls:'chip-esp', info:'CPU: Tensilica L106<br>Flash: 4MB<br>SRAM: 80KB<br>Speed: 80MHz<br>WiFi: 802.11 b/g/n<br>BLE: No'},
  nodemcu:  {label:'8',  chip:'NodeMCU • ESP8266',         cls:'chip-esp', info:'CPU: Tensilica L106<br>Flash: 4MB<br>SRAM: 80KB<br>Speed: 80MHz<br>WiFi: 802.11 b/g/n<br>BLE: No'},
  pico:     {label:'π',  chip:'Pi Pico • RP2040',          cls:'chip-avr', info:'CPU: ARM Cortex-M0+<br>Flash: 2MB<br>SRAM: 264KB<br>Speed: 133MHz<br>WiFi: No<br>BLE: No'},
};
function onBoardChange() {
  const sel=document.getElementById('boardSelect');
  const info=BOARD_INFO[sel.value]; if(!info) return;
  document.getElementById('boardIconLabel').textContent=info.label;
  const chip=document.getElementById('boardChip');
  chip.className='chip-badge '+info.cls; chip.textContent=info.chip;
  document.getElementById('boardInfo').innerHTML=info.info;
  document.getElementById('statusBoard').textContent='⚡ '+sel.options[sel.selectedIndex].text;
  addLog('info','Board: '+sel.options[sel.selectedIndex].text);
}

// ── Format ────────────────────────────────────────────────────────────────────
function formatCode() {
  const formatted = getCode().replace(/\t/g, '  ');
  setCode(formatted);
  files[currentTab] = formatted;
  addLog('success', '✓ Code formatted (tabs → spaces)');
}

// ── Font size ─────────────────────────────────────────────────────────────────
function increaseFontSize() {
  fontSize = Math.min(22, fontSize + 1);
  if (cmEditor) cmEditor.getWrapperElement().style.fontSize = fontSize + 'px';
  else editor.style.fontSize = fontSize + 'px';
}
function decreaseFontSize() {
  fontSize = Math.max(9, fontSize - 1);
  if (cmEditor) cmEditor.getWrapperElement().style.fontSize = fontSize + 'px';
  else editor.style.fontSize = fontSize + 'px';
}

// ── Theme ─────────────────────────────────────────────────────────────────────
let darkTheme=true;
function toggleTheme() {
  darkTheme=!darkTheme; const r=document.documentElement;
  if (!darkTheme) {
    r.style.setProperty('--bg','#f5f5f0'); r.style.setProperty('--bg2','#ebebE3');
    r.style.setProperty('--bg3','#e0e0d8'); r.style.setProperty('--bg4','#d4d4cc');
    r.style.setProperty('--border','#ccccc0'); r.style.setProperty('--text','#1a1a1a');
    r.style.setProperty('--text2','#555'); r.style.setProperty('--text3','#888');
  } else {
    r.style.setProperty('--bg','#0d0f14'); r.style.setProperty('--bg2','#13161d');
    r.style.setProperty('--bg3','#1a1e28'); r.style.setProperty('--bg4','#22273a');
    r.style.setProperty('--border','#2a2f42'); r.style.setProperty('--text','#e8ecf4');
    r.style.setProperty('--text2','#8b92a8'); r.style.setProperty('--text3','#5a6178');
  }
}

// ── Library ───────────────────────────────────────────────────────────────────
function addLib(name) {
  addLog('info',`Installing: ${name}...`);
  setTimeout(()=>addLog('success',`✓ ${name} installed (run arduino-cli lib install "${name}" for real install)`),900);
}

// ── Resize panel ──────────────────────────────────────────────────────────────
const handle=document.getElementById('resizeHandle');
const panel=document.getElementById('bottomPanel');
let dragging=false, startY=0, startH=0;
handle.addEventListener('mousedown',e=>{dragging=true;startY=e.clientY;startH=panel.offsetHeight;document.body.style.cursor='ns-resize';document.body.style.userSelect='none';});
document.addEventListener('mousemove',e=>{if(!dragging)return;panel.style.height=Math.max(80,Math.min(500,startH+(startY-e.clientY)))+'px';});
document.addEventListener('mouseup',()=>{dragging=false;document.body.style.cursor='';document.body.style.userSelect='';});

// ── Sidebar mobile toggle ─────────────────────────────────────────────────────
function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const isOpen   = sidebar.classList.contains('mobile-open');
  if (isOpen) {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
  } else {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('visible');
  }
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop').classList.remove('visible');
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
