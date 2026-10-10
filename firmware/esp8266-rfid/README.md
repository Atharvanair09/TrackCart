# ESP8266 RC522 RFID Node (Phase 2)

This module handles detecting 13.56 MHz RFID tags/cards using an RC522 module connected via SPI to a NodeMCU ESP8266 (ESP-12E). In Phase 2, this module also connects to Wi-Fi and sends HTTP POST requests to a backend API when an RFID tag is detected.

## Features

- **RFID Detection:** Reads 13.56 MHz tags.
- **Client-Side Debounce:** Prevents sending multiple requests rapidly for a stationary tag.
- **Wi-Fi Connectivity:** Non-blocking connection and reconnection logic.
- **Backend Communication:** Sends HTTP POST requests containing the device ID and tag UID.
- **Offline Resilience:** Fails fast during network outages to preserve continuous RFID scanning.

## Hardware Wiring Diagram

| RC522 Pin | NodeMCU Pin | GPIO |
|-----------|-------------|------|
| 3.3V      | 3V3         | -    |
| GND       | GND         | -    |
| RST       | D1          | 5    |
| SDA/SS    | D2          | 4    |
| MOSI      | D7          | 13   |
| MISO      | D6          | 12   |
| SCK       | D5          | 14   |
| IRQ       | (Not connected)| - |

## Project Structure

The project code is now located in the `src/` directory to facilitate a more modular structure:
- `src/main.cpp`: Entry point tying the subsystem loops together.
- `src/config.h`: Centralized configuration file (Wi-Fi, URLs, constants).
- `src/network.h` & `src/network.cpp`: Handles Wi-Fi connection and HTTP requests.
- `src/rfid.h` & `src/rfid.cpp`: Handles SPI initialization and MFRC522 interactions.

## Setup and Configuration

1. Open `src/config.h`.
2. Update `WIFI_SSID` and `WIFI_PASSWORD` with your network credentials.
3. Update `BACKEND_BASE_URL` to point to your backend server (e.g., `http://192.168.1.100:8080`).
4. Update `DEVICE_ID` if you are flashing multiple carts.

## Required Libraries

This project uses the following libraries:
- `MFRC522` by GithubCommunity
- `ESP8266WiFi` (built-in with ESP8266 board core)
- `ESP8266HTTPClient` (built-in with ESP8266 board core)

## API Communication

When a new RFID UID is detected, the device sends an HTTP POST request to the backend.

### Request Format

**Endpoint:** `POST /api/rfid/events`
**Content-Type:** `application/json`

**Payload:**
```json
{
  "deviceId": "cart-001",
  "tagUid": "0A:1B:2C:3D",
  "event": "TAG_DETECTED"
}
```

### Expected Backend Response

The backend should acknowledge the event with a 2xx HTTP status code (e.g., `200 OK` or `201 Created`). 
The ESP8266 does not parse the response JSON since product lookup and cart management logic are handled entirely by the backend. It only checks the HTTP response code to log success or failure.

## Troubleshooting

- **"Firmware Version: 0x0" or "0xFF"**: The SPI connection is failing. Check your wiring (MISO/MOSI/SCK/SS/RST). Ensure the module is getting exactly 3.3V, not 5V.
- **Network connection failed**: Ensure `WIFI_SSID` and `WIFI_PASSWORD` are correct in `src/config.h`. Check if your router supports 2.4 GHz (ESP8266 does not support 5 GHz).
- **HTTP POST failed**: Check if the `BACKEND_BASE_URL` is correct and accessible from the ESP8266 network.
- **Duplicate Scans**: The code uses `PICC_HaltA()` and software debouncing (configured in `config.h`) to prevent duplicate requests. You must physically remove the card from the reader and present it again to trigger another event.
