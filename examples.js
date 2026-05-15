// ── Code examples & default config ──
const EXAMPLES = {
  blink: `// Blink LED
#define LED_PIN 2

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  Serial.println("LED ON");
  delay(1000);
  digitalWrite(LED_PIN, LOW);
  Serial.println("LED OFF");
  delay(1000);
}`,

  serial: `// Serial Hello World
#include <Arduino.h>
int counter = 0;

void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("=== Hello from FlashForge! ===");
}

void loop() {
  Serial.printf("Count: %d | Uptime: %lums\\n", counter++, millis());
  delay(500);
}`,

  wifi: `// WiFi Connect — ESP32
#include <WiFi.h>

const char* SSID     = "YOUR_SSID";
const char* PASSWORD = "YOUR_PASSWORD";

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASSWORD);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\\n✓ Connected! IP: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); }
  delay(5000);
}`,

  dht22: `// DHT22 Sensor
#include <DHT.h>
#define DHTPIN  4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

void setup() { Serial.begin(115200); dht.begin(); }

void loop() {
  delay(2000);
  float h = dht.readHumidity(), t = dht.readTemperature();
  if (!isnan(h) && !isnan(t))
    Serial.printf("Temp: %.1f°C | Humidity: %.1f%%\\n", t, h);
}`,

  ble: `// BLE Scanner — ESP32
#include <BLEDevice.h>
#include <BLEScan.h>
BLEScan* pBLEScan;

class CB : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice d) {
    Serial.printf("  %s RSSI:%d\\n", d.getAddress().toString().c_str(), d.getRSSI());
  }
};

void setup() {
  Serial.begin(115200);
  BLEDevice::init("ESP32-Scanner");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new CB());
  pBLEScan->setActiveScan(true);
}

void loop() {
  Serial.println("Scanning...");
  BLEScanResults r = pBLEScan->start(5, false);
  Serial.printf("Found %d devices\\n", r.getCount());
  pBLEScan->clearResults();
  delay(2000);
}`,

  deepsleep: `// Deep Sleep — ESP32
#include <Arduino.h>
#define uS_TO_S 1000000ULL
#define SLEEP_S 10
RTC_DATA_ATTR int boots = 0;

void setup() {
  Serial.begin(115200); delay(100);
  Serial.printf("Boot #%d\\n", ++boots);
  Serial.println("Working... going to sleep.");
  delay(1000);
  esp_sleep_enable_timer_wakeup(SLEEP_S * uS_TO_S);
  esp_deep_sleep_start();
}

void loop() {}`,

  analog: `// Analog Read
#define PIN 34  // GPIO34 on ESP32 (ADC1)

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
}

void loop() {
  int raw = analogRead(PIN);
  float v = raw * 3.3f / 4095.0f;
  Serial.printf("Raw:%4d  Voltage:%.3fV\\n", raw, v);
  delay(200);
}`,

  ultrasonic: `// HC-SR04 Ultrasonic
#define TRIG 5
#define ECHO 18

float ping() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long d = pulseIn(ECHO, HIGH, 30000);
  return d ? (d * 0.034f / 2.0f) : -1;
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
}

void loop() {
  float cm = ping();
  cm < 0 ? Serial.println("Out of range") : Serial.printf("%.1f cm\\n", cm);
  delay(200);
}`
};

const CONFIG_H = `// config.h — Project Configuration
#pragma once

#define WIFI_SSID      "YOUR_SSID"
#define WIFI_PASSWORD  "YOUR_PASSWORD"

#define MQTT_HOST      "broker.hivemq.com"
#define MQTT_PORT      1883
#define DEVICE_ID      "esp32-device-01"

#define LED_PIN        2
#define ANALOG_PIN     34
#define I2C_SDA        21
#define I2C_SCL        22

#define ENABLE_WIFI    1
#define ENABLE_BLE     0
#define DEBUG_LEVEL    2`;
