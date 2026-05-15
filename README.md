# ⚡ Kurunotchi IDE

A web-based IDE for **ESP32** and **Arduino** with real compilation and flashing via `arduino-cli`.

> [!IMPORTANT]
> **Serial ports are physical hardware.** Even if you access this IDE from Vercel or any other hosted URL,
> **you must run `node server.js` on your own computer** to compile, upload, and use the serial monitor.
> The hosted page is just a UI — all hardware access happens through your local backend.

## Features
- 🔌 Real serial port detection
- ✅ Compile sketches with `arduino-cli`
- ⚡ Upload/flash firmware to real hardware
- 📡 Live serial monitor via WebSocket
- 🎨 Dark/light theme, syntax-highlighted editor
- 📂 Built-in code examples (WiFi, BLE, DHT22, deep sleep, etc.)

## Requirements

- [Node.js](https://nodejs.org/) >= 18
- [arduino-cli](https://arduino.github.io/arduino-cli/) installed and in PATH

## Setup

```bash
# Install dependencies
npm install

# Install board cores (first time only)
arduino-cli core install esp32:esp32
arduino-cli core install arduino:avr

# Start the server
node server.js
```

Then open **http://localhost:3000** in Chrome or Edge.

## Project Structure

```
Kurunotchi_IDE/
├── index.html      # UI markup
├── style.css       # Styling
├── examples.js     # Code examples
├── script.js       # Frontend logic (API + WebSocket)
├── server.js       # Node.js backend (arduino-cli + serialport)
└── package.json
```

## How to Use

1. Plug in your ESP32 or Arduino
2. Select the **board** and **port** in the top bar
3. Write your sketch in the editor
4. Click **▶ Verify** to compile, or **⚡ Upload** to flash
5. Use the **Serial Monitor** tab to read/send serial data
