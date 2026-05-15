/**
 * FlashForge IDE — Backend Server
 * Provides: serial port listing, arduino-cli compile/upload, WebSocket serial monitor
 *
 * Requirements:
 *   - Node.js >= 18
 *   - arduino-cli installed & in PATH  (https://arduino.github.io/arduino-cli)
 *   - npm install
 */

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '10mb' }));

// Allow requests from file:// and any localhost origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname)));   // serve index.html, style.css, script.js

// ── Fully Qualified Board Names ──────────────────────────────────────────────
const FQBN = {
  esp32:    'esp32:esp32:esp32',
  esp32s3:  'esp32:esp32:esp32s3',
  esp32c3:  'esp32:esp32:esp32c3',
  esp32s2:  'esp32:esp32:esp32s2',
  uno:      'arduino:avr:uno',
  nano:     'arduino:avr:nano',
  mega:     'arduino:avr:mega',
  leonardo: 'arduino:avr:leonardo',
  mkr:      'arduino:samd:mkrwifi1010',
  wemos:    'esp8266:esp8266:d1_mini',
  nodemcu:  'esp8266:esp8266:nodemcuv2',
  pico:     'rp2040:rp2040:rpipico',
};

// ── Serial state ─────────────────────────────────────────────────────────────
let activeSerial  = null;
const serialClients = new Set();

// ── Helper: create temp sketch dir ───────────────────────────────────────────
function writeTempSketch(code) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'flashforge-'));
  const sketchDir = path.join(tmpDir, 'sketch');
  fs.mkdirSync(sketchDir);
  fs.writeFileSync(path.join(sketchDir, 'sketch.ino'), code);
  return { tmpDir, sketchDir };
}

function cleanupTemp(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── GET /api/ports ───────────────────────────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports.map(p => ({
      path:         p.path,
      manufacturer: p.manufacturer  || '',
      serialNumber: p.serialNumber  || '',
      vendorId:     p.vendorId      || '',
      productId:    p.productId     || '',
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/compile ────────────────────────────────────────────────────────
// Body: { code: string, board: string }
// Response: { success, output }
app.post('/api/compile', (req, res) => {
  const { code, board } = req.body;
  const fqbn = FQBN[board];
  if (!fqbn) return res.status(400).json({ error: `Unknown board: ${board}` });
  if (!code)  return res.status(400).json({ error: 'No code provided' });

  const { tmpDir, sketchDir } = writeTempSketch(code);

  exec(
    `arduino-cli compile --fqbn "${fqbn}" "${sketchDir}"`,
    { timeout: 120_000 },
    (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      res.json({ success: !err, output });
      setTimeout(() => cleanupTemp(tmpDir), 5000);
    }
  );
});

// ── POST /api/upload  (Server-Sent Events stream) ────────────────────────────
// Body: { code: string, board: string, port: string }
// Streams SSE: { type: 'log'|'done', text?, success? }
app.post('/api/upload', (req, res) => {
  const { code, board, port } = req.body;
  const fqbn = FQBN[board];
  if (!fqbn) return res.status(400).json({ error: `Unknown board: ${board}` });
  if (!code)  return res.status(400).json({ error: 'No code provided' });
  if (!port)  return res.status(400).json({ error: 'No port provided' });

  // Disconnect serial monitor on same port so avrdude/esptool can access it
  if (activeSerial && activeSerial.path === port) {
    activeSerial.close();
    activeSerial = null;
    broadcast({ type: 'serial_disconnected', reason: 'upload' });
  }

  const { tmpDir, sketchDir } = writeTempSketch(code);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const child = spawn('arduino-cli', [
    'compile',
    '--fqbn', fqbn,
    '--upload',
    '-p', port,
    sketchDir,
  ]);

  child.stdout.on('data', d => send({ type: 'log', text: d.toString() }));
  child.stderr.on('data', d => send({ type: 'log', text: d.toString() }));

  child.on('close', code => {
    send({ type: 'done', success: code === 0 });
    res.end();
    setTimeout(() => cleanupTemp(tmpDir), 5000);
  });

  req.on('close', () => child.kill());
});

// ── WebSocket — Serial Monitor ───────────────────────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  serialClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

wss.on('connection', ws => {
  serialClients.add(ws);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── connect ──
    if (msg.type === 'connect') {
      if (activeSerial) { try { activeSerial.close(); } catch (_) {} }

      try {
        activeSerial = new SerialPort({ path: msg.port, baudRate: msg.baudRate || 115200 });

        activeSerial.on('open', () => {
          ws.send(JSON.stringify({ type: 'connected', port: msg.port, baudRate: msg.baudRate || 115200 }));
        });

        activeSerial.on('data', chunk => {
          broadcast({ type: 'data', text: chunk.toString() });
        });

        activeSerial.on('error', err => {
          broadcast({ type: 'error', text: err.message });
        });

        activeSerial.on('close', () => {
          broadcast({ type: 'serial_disconnected' });
          activeSerial = null;
        });

      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', text: e.message }));
      }
    }

    // ── send data ──
    if (msg.type === 'send' && activeSerial?.isOpen) {
      activeSerial.write(msg.text + '\n', err => {
        if (err) ws.send(JSON.stringify({ type: 'error', text: err.message }));
      });
    }

    // ── disconnect ──
    if (msg.type === 'disconnect') {
      if (activeSerial) {
        activeSerial.close();
        activeSerial = null;
      }
      ws.send(JSON.stringify({ type: 'disconnected' }));
    }

    // ── change baud rate ──
    if (msg.type === 'set_baud' && activeSerial) {
      activeSerial.update({ baudRate: msg.baudRate }, err => {
        if (err) ws.send(JSON.stringify({ type: 'error', text: err.message }));
        else ws.send(JSON.stringify({ type: 'baud_changed', baudRate: msg.baudRate }));
      });
    }
  });

  ws.on('close', () => serialClients.delete(ws));
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚡ FlashForge IDE running at http://localhost:${PORT}`);
  console.log('   Make sure arduino-cli is installed: https://arduino.github.io/arduino-cli\n');
});
