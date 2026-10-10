# Camera Capture Client

This is a lightweight Python client designed to request JPEG frames from the ESP32-CAM module over HTTP. It fulfills PHASE 5 of the Smart Shopping Cart project by supporting continuous capture modes at a target FPS.

## Features
- Requests JPEGs continuously from `http://<ESP32_IP>/capture` at a configurable target FPS.
- Validates each response to ensure it's a valid JPEG image (checks magic bytes).
- Saves images sequentially (e.g., `frame_000001.jpg`) into a timestamp-based session directory.
- Avoids overwriting existing session files.
- Handles timeouts, connection errors, and filesystem issues gracefully without crashing the capture loop.
- Tracks metrics like actual FPS, average image size, and success rates.
- No external dependencies (no OpenCV, no Flask). Uses standard Python libraries.

## Requirements
- Python 3.6+

## Usage

### Basic Continuous Capture
Run the script by providing the IP address of your ESP32-CAM. By default, it captures at 1 FPS until you press Ctrl+C:

```bash
python capture_client.py --ip <ESP32_IP>
```

Images will be saved in `data/captured_images/session_YYYYMMDD_HHMMSS/` relative to where you execute the script.

### 30-Second Test at 1 FPS
You can specify a duration in seconds using `--duration`:

```bash
python capture_client.py --ip <ESP32_IP> --fps 1 --duration 30
```
This will attempt to capture ~30 frames over 30 seconds and stop automatically.

### Fixed Frame Count
You can specify a total number of frames using `--frames`:

```bash
python capture_client.py --ip <ESP32_IP> --fps 1 --frames 100
```
This will stop after attempting to capture 100 frames.

### Full Options

```bash
python capture_client.py --help
usage: capture_client.py [-h] --ip IP [--output OUTPUT] [--timeout TIMEOUT]
                         [--fps FPS] [--duration DURATION] [--frames FRAMES]

Capture JPEG frames from the ESP32-CAM.

options:
  -h, --help           show this help message and exit
  --ip IP              IP address of the ESP32-CAM
  --output OUTPUT      Base output directory (default: data/captured_images)
  --timeout TIMEOUT    Timeout for HTTP requests in seconds (default: 5.0)
  --fps FPS            Target frames per second (default: 1.0)
  --duration DURATION  Capture duration in seconds (optional)
  --frames FRAMES      Number of frames to capture (optional)
```
