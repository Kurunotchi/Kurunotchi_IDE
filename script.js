// ─────────────────────────────────────────────────────────────────────────────
// FlashForge IDE — Frontend (connects to Node.js backend on localhost:3000)
// ─────────────────────────────────────────────────────────────────────────────

// Always talk to the local backend, regardless of how the page was opened.
const BACKEND_HOST = 'localhost:3000';
const API    = `http://${BACKEND_HOST}`;
const WS_URL = `ws://${BACKEND_HOST}`;

// ── State ────────────────────────────────────────────────────────────────────
let currentTab   = 'main';
let currentPanel = 'output';
let files        = { main: EXAMPLES.blink, config: CONFIG_H };
let fontSize     = 13.5;
let isConnected  = false;   // serial port connected
let logCount     = 0;
let ws           = null;    // WebSocket to backend serial monitor

const editor   = document.getElementById('codeEditor');
const lineNums = document.getElementById('lineNumbers');

// ── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  editor.value = files.main;
  updateLineNumbers();
  updateStatusChars();
  checkBackend();
}

// ── Backend health check ──────────────────────────────────────────────────────
async function checkBackend() {
  try {
    const res = await fetch(`${API}/api/ports`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('bad response');
    hideBackendBanner();
    addLog('success', '✓ Local backend connected (localhost:3000)');
    connectWS();
    refreshPorts();
  } catch {
    showBackendBanner();
    addLog('error', '✗ Local backend not found at localhost:3000');
    addLog('warn', 'Run:  node server.js  in the Kurunotchi_IDE folder, then refresh.');
    // keep retrying every 5s
    setTimeout(checkBackend, 5000);
  }
}

function showBackendBanner() {
  if (document.getElementById('backendBanner')) return;
  const b = document.createElement('div');
  b.id = 'backendBanner';
  b.style.cssText = [
    'position:fixed','top:0','left:0','right:0','z-index:999',
    'background:linear-gradient(135deg,#1a0a00,#2a1200)',
    'border-bottom:2px solid #ff6b6b',
    'padding:10px 20px','display:flex','align-items:center','gap:16px',
    'font-family:var(--font-ui)','font-size:13px','color:#e8ecf4'
  ].join(';');
  b.innerHTML = `
    <span style="font-size:20px">⚠️</span>
    <div>
      <strong style="color:#ff6b6b">Local backend not running.</strong>
      Serial ports, compile and upload require the backend on your machine.<br>
      <span style="color:#8b92a8">1. Clone/download the repo &nbsp;|&nbsp;
      2. Run <code style="background:#2a2f42;padding:1px 6px;border-radius:4px">npm install</code> &nbsp;|&nbsp;
      3. Run <code style="background:#2a2f42;padding:1px 6px;border-radius:4px">node server.js</code> &nbsp;|&nbsp;
      4. Open <code style="background:#2a2f42;padding:1px 6px;border-radius:4px">http://localhost:3000</code></span>
    </div>
    <button onclick="checkBackend()" style="margin-left:auto;padding:6px 14px;border-radius:6px;background:#ff6b6b;color:#000;border:none;font-weight:700;cursor:pointer">Retry</button>
  `;
  document.body.prepend(b);
}

function hideBackendBanner() {
  const b = document.getElementById('backendBanner');
  if (b) b.remove();
}

// ── WebSocket (serial monitor) ───────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => addLog('info', 'Backend WebSocket connected ✓');

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'connected') {
      isConnected = true;
      document.getElementById('portDot').className = 'port-dot connected';
      document.getElementById('statusPort').textContent = '● ' + msg.port;
      document.getElementById('serialInputRow').style.display = 'flex';
      appendSerial(`<span style="color:var(--green)">✓ Serial connected — ${msg.port} @ ${msg.baudRate} baud</span>`);
      addLog('success', `Serial monitor connected: ${msg.port} @ ${msg.baudRate} baud`);
    }

    if (msg.type === 'disconnected' || msg.type === 'serial_disconnected') {
      isConnected = false;
      document.getElementById('portDot').className = 'port-dot';
      document.getElementById('serialInputRow').style.display = 'none';
      if (msg.reason === 'upload') {
        appendSerial('<span style="color:var(--yellow)">⚠ Serial closed for upload — will reconnect after flash</span>');
      } else {
        appendSerial('<span style="color:var(--text3)">Serial disconnected.</span>');
      }
    }

    if (msg.type === 'data') {
      appendSerial(escapeHtml(msg.text));
    }

    if (msg.type === 'error') {
      appendSerial(`<span style="color:var(--red)">Error: ${escapeHtml(msg.text)}</span>`);
      addLog('error', msg.text);
    }
  };

  ws.onclose = () => {
    // don't spam retries — checkBackend loop will reconnect
    setTimeout(checkBackend, 5000);
  };

  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Serial helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function appendSerial(html) {
  const out = document.getElementById('serialOutput');
  out.innerHTML += html + '\n';
  out.scrollTop = out.scrollHeight;
}

// ── Port detection ────────────────────────────────────────────────────────────
async function refreshPorts() {
  try {
    const res   = await fetch(`${API}/api/ports`);
    const ports = await res.json();
    const sel   = document.getElementById('portSelect');
    const prev  = sel.value;

    // Keep the placeholder
    sel.innerHTML = '<option value="">-- Select Port --</option>';
    ports.forEach(p => {
      const label = p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path;
      sel.innerHTML += `<option value="${p.path}">${label}</option>`;
    });

    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    if (ports.length === 0) addLog('warn', 'No serial ports detected. Plug in your device.');
    else addLog('info', `Found ${ports.length} serial port(s)`);
  } catch {
    addLog('warn', 'Could not fetch ports — is the backend running?');
  }
}

// ── Port connect/disconnect ───────────────────────────────────────────────────
function onPortChange() {
  const port = document.getElementById('portSelect').value;
  if (!port) {
    wsSend({ type: 'disconnect' });
    document.getElementById('statusPort').textContent = '⊖ No Port';
    return;
  }
  const baud = parseInt(document.getElementById('baudRate').value, 10);
  wsSend({ type: 'connect', port, baudRate: baud });
  document.getElementById('statusPort').textContent = '⌛ ' + port;
  switchPanel('serial');
}

// ── Serial monitor send ───────────────────────────────────────────────────────
function sendSerial() {
  const input = document.getElementById('serialInput');
  const val   = input.value.trim();
  if (!val) return;
  wsSend({ type: 'send', text: val });
  appendSerial(`<span style="color:var(--accent2)">→ ${escapeHtml(val)}</span>`);
  input.value = '';
}

// ── Verify (compile only) ─────────────────────────────────────────────────────
async function verifyCode() {
  const btn   = document.getElementById('verifyBtn');
  const board = document.getElementById('boardSelect').value;
  btn.textContent = '⏳ Verifying...';
  btn.disabled    = true;
  switchPanel('output');

  addLog('info', '─── Compiling ───');
  addLog('info', `Board: ${document.getElementById('boardSelect').options[document.getElementById('boardSelect').selectedIndex].text}`);

  try {
    const res  = await fetch(`${API}/api/compile`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code: editor.value, board }),
    });
    const data = await res.json();

    data.output.split('\n').filter(Boolean).forEach(line => {
      if (/error:/i.test(line))   addLog('error', line);
      else if (/warn:/i.test(line)) addLog('warn', line);
      else                          addLog('info', line);
    });

    if (data.success) {
      addLog('success', '✓ Compilation successful — no errors.');
      document.getElementById('errorCount').style.display = 'none';
    } else {
      addLog('error', '✗ Compilation failed. See errors above.');
      document.getElementById('errorCount').style.display = 'inline';
      document.getElementById('errorCount').textContent = '!';
    }
  } catch (e) {
    addLog('error', `Backend error: ${e.message}`);
  }

  btn.textContent = '▶ Verify';
  btn.disabled    = false;
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function uploadCode() {
  const port  = document.getElementById('portSelect').value;
  const board = document.getElementById('boardSelect').value;

  if (!port) {
    addLog('warn', '⚠ No port selected! Plug in your device and select a port.');
    switchPanel('output');
    return;
  }

  // Show overlay
  const overlay      = document.getElementById('uploadOverlay');
  const progressBar  = document.getElementById('progressBar');
  const progressLabel = document.getElementById('progressLabel');
  document.getElementById('uploadTitle').textContent = 'Uploading...';
  document.getElementById('uploadSub').textContent   = `Flashing to ${document.getElementById('boardSelect').options[document.getElementById('boardSelect').selectedIndex].text}`;

  [1,2,3,4,5].forEach(i => {
    document.getElementById('dot'  + i).className  = 'step-dot';
    document.getElementById('step' + i).className  = 'upload-step';
  });
  setStep(1, 'active');
  overlay.classList.add('show');
  progressBar.style.width = '0%';
  progressLabel.textContent = '0%';

  addLog('info', '─── Uploading ───');
  switchPanel('output');

  // Phase map: detect keywords in arduino-cli output → advance step
  const phaseKeywords = [
    { pct: 20,  step: 1, next: 2, kw: /Compiling/i },
    { pct: 50,  step: 2, next: 3, kw: /Linking/i },
    { pct: 70,  step: 3, next: 4, kw: /Writing|Uploading|esptool|avrdude/i },
    { pct: 90,  step: 4, next: 5, kw: /Verifying|Hash of data/i },
  ];
  let phaseIdx = 0;

  try {
    const res = await fetch(`${API}/api/upload`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code: editor.value, board, port }),
    });

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop();                   // keep incomplete

      for (const raw of events) {
        const line = raw.replace(/^data: /, '').trim();
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'log') {
          const text = msg.text.trim();
          if (!text) continue;
          if (/error:/i.test(text))   addLog('error', text);
          else if (/warn:/i.test(text)) addLog('warn', text);
          else                          addLog('info', text);

          // Advance upload steps
          while (phaseIdx < phaseKeywords.length && phaseKeywords[phaseIdx].kw.test(text)) {
            const p = phaseKeywords[phaseIdx];
            setStep(p.step, 'done');
            if (p.next <= 5) setStep(p.next, 'active');
            progressBar.style.width   = p.pct + '%';
            progressLabel.textContent = p.pct + '%';
            phaseIdx++;
          }
        }

        if (msg.type === 'done') {
          if (msg.success) {
            [1,2,3,4,5].forEach(i => setStep(i, 'done'));
            progressBar.style.width   = '100%';
            progressLabel.textContent = '100%';
            document.getElementById('uploadTitle').textContent = 'Upload Complete!';
            document.getElementById('uploadSub').textContent   = 'Device is running your code';
            addLog('success', '✓ Upload successful!');

            // Re-connect serial after a short delay
            setTimeout(() => {
              const baud = parseInt(document.getElementById('baudRate').value, 10);
              wsSend({ type: 'connect', port, baudRate: baud });
              switchPanel('serial');
            }, 1500);
          } else {
            document.getElementById('uploadTitle').textContent = 'Upload Failed';
            document.getElementById('uploadSub').textContent   = 'Check the Output tab for errors';
            addLog('error', '✗ Upload failed. See output above.');
          }
          setTimeout(() => overlay.classList.remove('show'), 1800);
        }
      }
    }
  } catch (e) {
    addLog('error', `Upload error: ${e.message}`);
    overlay.classList.remove('show');
  }
}

function setStep(n, state) {
  document.getElementById('dot'  + n).className  = 'step-dot ' + state;
  document.getElementById('step' + n).className  = 'upload-step ' + state;
}

// ── Line numbers ──────────────────────────────────────────────────────────────
function updateLineNumbers() {
  const lines   = editor.value.split('\n');
  const curLine = editor.value.substr(0, editor.selectionStart).split('\n').length;
  lineNums.innerHTML = lines.map((_, i) => {
    const cls = i + 1 === curLine ? ' current' : '';
    return `<div class="line-num${cls}">${i + 1}</div>`;
  }).join('');
}

function syncScroll() { lineNums.scrollTop = editor.scrollTop; }

function onEditorInput() {
  files[currentTab] = editor.value;
  updateLineNumbers();
  updateStatusChars();
}

function updateStatusChars() {
  document.getElementById('statusChars').textContent = editor.value.length + ' chars';
}

function updateCursor() {
  const text  = editor.value.substr(0, editor.selectionStart);
  const lines = text.split('\n');
  document.getElementById('cursorPos').textContent = `Ln ${lines.length}, Col ${lines[lines.length-1].length+1}`;
  updateLineNumbers();
}

// ── Key bindings ──────────────────────────────────────────────────────────────
function handleKeydown(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart, end = editor.selectionEnd;
    editor.value = editor.value.substring(0, s) + '  ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = s + 2;
    onEditorInput();
  }
  if (e.ctrlKey && e.key === 'r')                          { e.preventDefault(); verifyCode(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'U')            { e.preventDefault(); uploadCode(); }
  if (e.ctrlKey && e.shiftKey && e.key === 'F')            { e.preventDefault(); formatCode(); }
}

// ── File tabs ─────────────────────────────────────────────────────────────────
function switchTab(tab) {
  files[currentTab] = editor.value;
  currentTab = tab;
  editor.value = files[tab] || '';
  updateLineNumbers();
  updateStatusChars();
  document.getElementById('tab-main').style.color   = tab === 'main'   ? 'var(--accent)' : '';
  document.getElementById('tab-config').style.color = tab === 'config' ? 'var(--accent)' : '';
  // Sidebar active
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
  const match = [...document.querySelectorAll('.sidebar-item')].find(el => el.onclick?.toString().includes(`'${tab}'`));
  if (match) match.classList.add('active');
}

// ── Panel tabs ────────────────────────────────────────────────────────────────
function switchPanel(panel) {
  currentPanel = panel;
  ['output','serial','errors'].forEach(p => {
    document.getElementById(p + 'Panel').style.display = p === panel ? 'flex' : 'none';
    document.getElementById('tab-' + p).classList.toggle('active', p === panel);
  });
  document.getElementById('serialInputRow').style.display =
    (panel === 'serial' && isConnected) ? 'flex' : 'none';
}

// ── Logging ───────────────────────────────────────────────────────────────────
function getTime() {
  const n = new Date();
  return `${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`;
}

function addLog(type, msg) {
  const out = document.getElementById('outputPanel');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-time">[${getTime()}]</span><span class="log-${type}">${msg}</span>`;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  logCount++;
}

function clearOutput() {
  document.getElementById('outputPanel').innerHTML = '';
  document.getElementById('serialOutput').innerHTML = '';
  logCount = 0;
}

// ── Examples ──────────────────────────────────────────────────────────────────
function toggleDropdown() { document.getElementById('ddMenu').classList.toggle('open'); }

document.addEventListener('click', e => {
  if (!document.getElementById('examplesDD').contains(e.target))
    document.getElementById('ddMenu').classList.remove('open');
});

function loadExample(name) {
  files.main = EXAMPLES[name] || files.main;
  if (currentTab === 'main') editor.value = files.main;
  updateLineNumbers();
  document.getElementById('ddMenu').classList.remove('open');
  addLog('info', `Loaded example: ${name}`);
}

function newFile() {
  const name = prompt('New file name (e.g. helper.h):');
  if (name) addLog('info', `File "${name}" created (feature coming soon)`);
}

// ── Board select ──────────────────────────────────────────────────────────────
const BOARD_INFO = {
  esp32:    { label:'32', chip:'ESP32 • Xtensa LX6',        cls:'chip-esp', info:'CPU: Xtensa LX6<br>Flash: 4MB<br>SRAM: 520KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: 4.2/5.0' },
  esp32s3:  { label:'S3', chip:'ESP32-S3 • Xtensa LX7',     cls:'chip-esp', info:'CPU: Xtensa LX7<br>Flash: 8MB<br>SRAM: 512KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: 5.0' },
  esp32c3:  { label:'C3', chip:'ESP32-C3 • RISC-V',         cls:'chip-esp', info:'CPU: RISC-V 32-bit<br>Flash: 4MB<br>SRAM: 400KB<br>Speed: 160MHz<br>WiFi: 802.11 b/g/n<br>BLE: 5.0' },
  esp32s2:  { label:'S2', chip:'ESP32-S2 • Xtensa LX7',     cls:'chip-esp', info:'CPU: Xtensa LX7<br>Flash: 4MB<br>SRAM: 320KB<br>Speed: 240MHz<br>WiFi: 802.11 b/g/n<br>BLE: No' },
  uno:      { label:'Ω',  chip:'Arduino Uno • ATmega328P',  cls:'chip-avr', info:'CPU: ATmega328P<br>Flash: 32KB<br>SRAM: 2KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No' },
  nano:     { label:'N',  chip:'Arduino Nano • ATmega328P', cls:'chip-avr', info:'CPU: ATmega328P<br>Flash: 32KB<br>SRAM: 2KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No' },
  mega:     { label:'M',  chip:'Mega 2560 • ATmega2560',    cls:'chip-avr', info:'CPU: ATmega2560<br>Flash: 256KB<br>SRAM: 8KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No' },
  leonardo: { label:'L',  chip:'Leonardo • ATmega32u4',     cls:'chip-avr', info:'CPU: ATmega32u4<br>Flash: 32KB<br>SRAM: 2.5KB<br>Speed: 16MHz<br>WiFi: No<br>BLE: No' },
  mkr:      { label:'M',  chip:'MKR WiFi 1010 • SAMD21',   cls:'chip-avr', info:'CPU: ARM Cortex-M0+<br>Flash: 256KB<br>SRAM: 32KB<br>Speed: 48MHz<br>WiFi: 802.11 b/g/n<br>BLE: 4.2' },
  wemos:    { label:'8',  chip:'Wemos D1 • ESP8266',        cls:'chip-esp', info:'CPU: Tensilica L106<br>Flash: 4MB<br>SRAM: 80KB<br>Speed: 80MHz<br>WiFi: 802.11 b/g/n<br>BLE: No' },
  nodemcu:  { label:'8',  chip:'NodeMCU • ESP8266',         cls:'chip-esp', info:'CPU: Tensilica L106<br>Flash: 4MB<br>SRAM: 80KB<br>Speed: 80MHz<br>WiFi: 802.11 b/g/n<br>BLE: No' },
  pico:     { label:'π',  chip:'Pi Pico • RP2040',          cls:'chip-avr', info:'CPU: ARM Cortex-M0+<br>Flash: 2MB<br>SRAM: 264KB<br>Speed: 133MHz<br>WiFi: No<br>BLE: No' },
};

function onBoardChange() {
  const sel  = document.getElementById('boardSelect');
  const info = BOARD_INFO[sel.value];
  if (!info) return;
  document.getElementById('boardIconLabel').textContent = info.label;
  const chip = document.getElementById('boardChip');
  chip.className   = 'chip-badge ' + info.cls;
  chip.textContent = info.chip;
  document.getElementById('boardInfo').innerHTML = info.info;
  document.getElementById('statusBoard').textContent = '⚡ ' + sel.options[sel.selectedIndex].text;
  addLog('info', `Board: ${sel.options[sel.selectedIndex].text}`);
}

// ── Format ────────────────────────────────────────────────────────────────────
function formatCode() {
  editor.value = editor.value.replace(/\t/g, '  ');
  files[currentTab] = editor.value;
  addLog('success', '✓ Code formatted');
}

// ── Font size ─────────────────────────────────────────────────────────────────
function increaseFontSize() { fontSize = Math.min(20, fontSize+1); editor.style.fontSize = fontSize+'px'; }
function decreaseFontSize() { fontSize = Math.max(10, fontSize-1); editor.style.fontSize = fontSize+'px'; }

// ── Theme ─────────────────────────────────────────────────────────────────────
let darkTheme = true;
function toggleTheme() {
  darkTheme = !darkTheme;
  const r = document.documentElement;
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

// ── Library install ───────────────────────────────────────────────────────────
function addLib(name) {
  addLog('info', `Installing library: ${name}...`);
  setTimeout(() => addLog('success', `✓ ${name} installed (feature coming soon — use arduino-cli lib install "${name}")`), 900);
}

// ── Resize panel ──────────────────────────────────────────────────────────────
const handle = document.getElementById('resizeHandle');
const panel  = document.getElementById('bottomPanel');
let dragging = false, startY = 0, startH = 0;

handle.addEventListener('mousedown', e => {
  dragging = true; startY = e.clientY; startH = panel.offsetHeight;
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  panel.style.height = Math.max(80, Math.min(500, startH + (startY - e.clientY))) + 'px';
});
document.addEventListener('mouseup', () => {
  dragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

// ── Baud rate change ──────────────────────────────────────────────────────────
document.getElementById('baudRate').addEventListener('change', function() {
  if (isConnected) {
    wsSend({ type: 'set_baud', baudRate: parseInt(this.value, 10) });
  }
});

// ── Port refresh button (add to toolbar dynamically) ─────────────────────────
(function addRefreshBtn() {
  const btn = document.createElement('button');
  btn.className = 'tool-btn';
  btn.title = 'Refresh serial ports';
  btn.textContent = '🔄 Ports';
  btn.onclick = async () => {
    btn.textContent = '...';
    await refreshPorts();
    btn.textContent = '🔄 Ports';
  };
  document.querySelector('.port-select-wrap').after(btn);
})();

// ── Start ─────────────────────────────────────────────────────────────────────
init();
