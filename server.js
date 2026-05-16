/**
 * Kurunotchi IDE — Backend Server
 * Provides: arduino-cli compile/upload, /api/compile-bin (returns binary), WebSocket serial monitor
 *
 * Requirements:
 *   - Node.js >= 18
 *   - arduino-cli installed & in PATH  (https://arduino.github.io/arduino-cli)
 *   - npm install
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// SerialPort is optional — only needed for local serial monitor via WebSocket.
// In cloud deployments, the browser uses Web Serial API instead.
let SerialPort;
try {
  SerialPort = require('serialport').SerialPort;
  console.log('✓ serialport loaded (local serial monitor available)');
} catch {
  console.log('ℹ serialport not available — Web Serial API handles serial in browser');
}

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

// ── Health / status page ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name:   'Kurunotchi IDE Backend',
    version: '1.0.0',
    endpoints: ['/api/ports', '/api/compile', '/api/compile-bin'],
    info: 'Frontend is hosted on Vercel. This is the compile API only.',
  });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));


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

// ── Build the arduino-cli compile command ───────────────────────────────────────────
// --jobs 1  : single-threaded = lower peak RAM (critical on free Railway 512MB)
// --warnings none: skip warning pass = less memory
function compileCmd(fqbn, sketchDir, outDir) {
  const out  = outDir ? `--output-dir "${outDir}"` : '';
  return `arduino-cli compile --fqbn "${fqbn}" --jobs 1 --warnings none ${out} "${sketchDir}"`;
}

function oomMessage(signal, code) {
  if (signal === 'SIGKILL' || code === 137) {
    return 'Compilation was killed (out of memory).\n'
      + 'ESP32 compilation needs ~1.5 GB RAM. Railway free tier only provides 512 MB.\n'
      + 'Fix: Go to Railway → your service → Settings → upgrade to Starter plan ($5/mo).\n'
      + 'Alternative: Use Arduino IDE locally and upload the .bin with ⚡ Flash .bin.';
  }
  return null;
}

// ── GET /api/ports ───────────────────────────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  if (!SerialPort) return res.json([]);   // cloud mode — Web Serial API used instead
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
    compileCmd(fqbn, sketchDir, null),
    { timeout: 180_000 },
    (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      if (err) {
        const oom = oomMessage(err.signal, err.code);
        res.json({ success: false, output: oom ? oom : output });
      } else {
        res.json({ success: true, output });
      }
      setTimeout(() => cleanupTemp(tmpDir), 5000);
    }
  );
});

// ── POST /api/compile-bin ────────────────────────────────────────────────────────────────────────────
// Body: { code: string, board: string }
// Returns: binary file (.bin) as octet-stream, OR JSON error
// Header X-Compile-Output: base64-encoded compiler log
app.post('/api/compile-bin', (req, res) => {
  const { code, board } = req.body;
  const fqbn = FQBN[board];
  if (!fqbn) return res.status(400).json({ error: `Unknown board: ${board}` });
  if (!code)  return res.status(400).json({ error: 'No code provided' });

  const { tmpDir, sketchDir } = writeTempSketch(code);
  const buildDir = path.join(tmpDir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  exec(
    compileCmd(fqbn, sketchDir, buildDir),
    { timeout: 180_000 },
    (err, stdout, stderr) => {
      const log = (stdout + '\n' + stderr).trim();
      if (err) {
        cleanupTemp(tmpDir);
        const oom = oomMessage(err.signal, err.code);
        return res.status(400).json({ success: false, output: oom || log });
      }

      const files = fs.readdirSync(buildDir);
      let binFile = files.find(f => f.endsWith('.merged.bin'));

      // If no pre-merged bin exists, but we have the pieces (ESP32), merge them!
      if (!binFile && board.startsWith('esp32')) {
         const appFile  = files.find(f => f.endsWith('.ino.bin') && !f.includes('bootloader') && !f.includes('partitions'));
         const bootFile = files.find(f => f.endsWith('.bootloader.bin'));
         const partFile = files.find(f => f.endsWith('.partitions.bin'));
         
         if (appFile && bootFile && partFile) {
            const app  = fs.readFileSync(path.join(buildDir, appFile));
            const boot = fs.readFileSync(path.join(buildDir, bootFile));
            const part = fs.readFileSync(path.join(buildDir, partFile));
            
            const bootOffset = (board.includes('c3') || board.includes('s3')) ? 0x0 : 0x1000;
            const partOffset = 0x8000;
            const appOffset  = 0x10000;
            
            const mergedSize = appOffset + app.length;
            const merged = Buffer.alloc(mergedSize, 0xFF);
            
            boot.copy(merged, bootOffset);
            part.copy(merged, partOffset);
            app.copy(merged, appOffset);
            
            binFile = 'sketch.merged.bin';
            fs.writeFileSync(path.join(buildDir, binFile), merged);
         }
      }

      if (!binFile) {
        binFile = files.find(f => f.endsWith('.ino.bin')) ||
                  files.find(f => f.endsWith('.bin')) ||
                  files.find(f => f.endsWith('.ino.hex')) ||
                  files.find(f => f.endsWith('.hex'));
      }

      if (!binFile) {
        cleanupTemp(tmpDir);
        return res.status(500).json({ error: 'No binary produced', output: log });
      }

      const binPath = path.join(buildDir, binFile);
      const logB64  = Buffer.from(log).toString('base64');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${binFile}"`);
      res.setHeader('X-Compile-Output', logB64);
      res.setHeader('X-Bin-Name', binFile);

      const stream = fs.createReadStream(binPath);
      stream.pipe(res);
      stream.on('close', () => setTimeout(() => cleanupTemp(tmpDir), 2000));
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
  console.log(`\n🐢 Kurunotchi IDE backend running at http://localhost:${PORT}`);
  console.log('   arduino-cli required: https://arduino.github.io/arduino-cli\n');
});
