FROM node:20-slim

# Install dependencies for arduino-cli
RUN apt-get update && apt-get install -y curl ca-certificates python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install arduino-cli
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh

# Configure arduino-cli and install board cores
RUN arduino-cli config init
RUN arduino-cli config add board_manager.additional_urls \
    https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json \
    https://arduino.esp8266.com/stable/package_esp8266com_index.json
RUN arduino-cli core update-index
RUN arduino-cli core install arduino:avr
RUN arduino-cli core install esp32:esp32
RUN arduino-cli core install esp8266:esp8266

# App
WORKDIR /app
COPY package*.json ./
RUN npm install --production --ignore-scripts
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
