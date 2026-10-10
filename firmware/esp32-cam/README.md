# Smart Shopping Cart - ESP32-CAM Firmware

This directory contains the firmware for the camera module of the Smart Shopping Cart project. The code establishes a basic HTTP server that serves single JPEG captures and status information.

## Hardware Configuration
- **Board Used**: AI-Thinker ESP32-CAM
- **Camera Model**: OV2640

## Camera Configuration

For product detection within the shopping cart, the camera is initialized with specific settings to ensure optimal reliability and image clarity while minimizing overhead:

- **Resolution**: VGA (640x480). This provides sufficient detail for product recognition while keeping the image payload small enough for fast and stable Wi-Fi transmission.
- **JPEG Quality**: 12. A balanced compression level that preserves edges and colors without creating unnecessarily large files.
- **Image Adjustments**: Brightness, contrast, saturation, and sharpness are set to 0 to prevent artificial enhancement that could confuse detection algorithms.
- **Auto Exposure and White Balance**: Enabled. The shopping cart will move through varying lighting conditions (shadows from the user, different aisle lighting). Automatic exposure and white balance ensure that the product remains clearly visible regardless of ambient light.
- **No Edge ML**: On-device machine learning (like face detection) is explicitly disabled to free up RAM and processor cycles, offloading heavy processing to the backend server.

## Setup Instructions

### 1. Arduino IDE Setup
To compile and upload this code, ensure you have the ESP32 board manager installed in the Arduino IDE.
- **Required Arduino Board Selection**: `AI Thinker ESP32-CAM` (under ESP32 Arduino)
- **Required Libraries**: None external. Uses the built-in `esp_camera`, `esp_http_server`, and `WiFi` libraries included with the ESP32 Arduino core.

### 2. Wi-Fi Configuration
Before uploading, you must configure your Wi-Fi credentials:
1. Open `config.h`.
2. Edit the `WIFI_SSID` and `WIFI_PASSWORD` variables to match your local network.

### 3. Uploading the Firmware
We recommend using the **ESP32-CAM-MB** programming board for easy uploading via USB.
1. Connect the ESP32-CAM to the ESP32-CAM-MB.
2. Connect the ESP32-CAM-MB to your computer via micro-USB.
3. Select the appropriate COM port in the Arduino IDE.
4. Click **Upload**. (If it fails to connect, you may need to press the BOOT button on the ESP32-CAM-MB when you see "Connecting...").

### 4. Finding the Device IP Address
1. After a successful upload, open the **Serial Monitor** in the Arduino IDE.
2. Set the baud rate to `115200`.
3. Press the RST (Reset) button on the ESP32-CAM-MB.
4. The Serial Monitor will display the boot process, Wi-Fi connection attempts, and finally print the assigned IP address (e.g., `192.168.1.100`).

## Testing the API

Once you have the device's IP address, you can test the following endpoints in your web browser or via `curl`:

### `/capture` Endpoint
Returns a single JPEG image captured by the camera. This endpoint is designed to be reliable for a laptop or server client to request frames automatically.
- **URL**: `http://<ESP32_IP>/capture`
- **Example**: `http://192.168.1.100/capture`
- **cURL Example**:
  ```bash
  curl -o frame.jpg http://192.168.1.100/capture
  ```

### `/status` Endpoint
Returns a JSON response with the current device status.
- **URL**: `http://<ESP32_IP>/status`
- **Example**: `http://192.168.1.100/status`
- **Sample Output**:
  ```json
  {"camera_initialized":true, "wifi_connected":true, "ip_address":"192.168.1.100", "frame_width":800, "frame_height":600, "free_heap":450000, "uptime_s":120}
  ```

### `/camera-config` Endpoint
Returns a JSON response with the current internal camera configuration for diagnostic purposes.
- **URL**: `http://<ESP32_IP>/camera-config`
- **Example**: `http://192.168.1.100/camera-config`
- **Sample Output**:
  ```json
  {"resolution":"VGA(640x480)", "quality":12, "brightness":0, "contrast":0, "saturation":0, "sharpness":0, "whitebal":1, "auto_exposure":1, "auto_gain":1, "night_mode":0, "lens_correction":1}
  ```
