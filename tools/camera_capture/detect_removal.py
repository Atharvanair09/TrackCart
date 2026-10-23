#!/usr/bin/env python3
"""detect_removal.py – Offline/online detector for camera‑based item removal.

The script builds on the existing *capture_client.py* (frame acquisition) and
*compare_images.py* (pixel‑wise diff) utilities.  It establishes a baseline image
and then watches a live stream of JPEG frames.  When a sustained visual change
exceeds configurable thresholds, a **single** JSON‑Lines event is written to
`tools/camera_capture/logs/camera_events.log`.

Key design points required by the user:
* Configurable thresholds via environment variables.
* Consecutive‑frame confirmation before emitting an event.
* Manual baseline reset only via a CLI flag (no automatic reset).
* No backend POST – the detector works entirely offline.
* Distinguish addition vs removal only insofar as the current image‑diff
  pipeline can indicate a *scene_changed*; the emitted event includes a
  `classification` field that defaults to "scene_changed".
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Tuple

import cv2
import urllib.request
import urllib.error
import socket
import numpy as np

# ---------------------------------------------------------------------------
# Configuration – environment variables with sensible defaults
# ---------------------------------------------------------------------------
CAM_DIFF_THRESHOLD = int(os.getenv("CAM_DIFF_THRESHOLD", "30"))  # pixel intensity diff (same as compare_images default)
CAM_CHANGE_PERCENT = float(os.getenv("CAM_CHANGE_PERCENT", "2.0"))  # % of changed pixels to consider "significant"
CAM_CONSECUTIVE_FRAMES = int(os.getenv("CAM_CONSECUTIVE_FRAMES", "3"))
CAM_CORRELATION_WINDOW = int(os.getenv("CAM_CORRELATION_WINDOW", "5"))  # seconds for backend correlation window
CAM_API_ENDPOINT = os.getenv("CAM_API_ENDPOINT", "http://localhost:3000/api/camera/events")  # backend endpoint for camera events
CAM_ENDPOINT = os.getenv("CAM_ENDPOINT", "http://<ESP32_IP>/capture")
CAM_TIMEOUT = float(os.getenv("CAM_TIMEOUT", "5.0"))

LOG_DIR = Path(__file__).parent / "logs"
LOG_FILE = LOG_DIR / "camera_events.log"

# ---------------------------------------------------------------------------
# Helper: fetch a single JPEG frame from the ESP32‑CAM
# ---------------------------------------------------------------------------
def fetch_frame(url: str) -> bytes:
    """Request a JPEG frame via HTTP GET.

    Returns the raw JPEG bytes or raises an exception on timeout / network error.
    """
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=CAM_TIMEOUT) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} from camera endpoint")
        return resp.read()

# ---------------------------------------------------------------------------
# Helper: load image from bytes (JPEG) into an OpenCV BGR array
# ---------------------------------------------------------------------------
def img_from_bytes(data: bytes):
    nparr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("Failed to decode JPEG frame")
    return img

# ---------------------------------------------------------------------------
# Core comparison – mirrors the logic from compare_images.py (clean mask & pct)
# ---------------------------------------------------------------------------
def diff_percent(baseline_img, frame_img, threshold: int = CAM_DIFF_THRESHOLD) -> Tuple[float, int]:
    """Compute the percentage of changed pixels between two images.

    Returns a tuple ``(percent_changed, changed_pixels)`` where ``percent_changed``
    is the fraction of the total image area (0‑100).  The algorithm follows the
    ``compare_images.py`` pipeline: grayscale conversion, absolute diff, binary
    threshold, 3×3 morphological open+close, then count non‑zero pixels.
    """
    if baseline_img.shape != frame_img.shape:
        raise ValueError("Image dimensions do not match for diff computation")

    gray_base = cv2.cvtColor(baseline_img, cv2.COLOR_BGR2GRAY)
    gray_frame = cv2.cvtColor(frame_img, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(gray_base, gray_frame)
    _, mask = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask_clean = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask_clean = cv2.morphologyEx(mask_clean, cv2.MORPH_CLOSE, kernel)
    changed = int(cv2.countNonZero(mask_clean))
    h, w = gray_base.shape
    total = h * w
    percent = (changed / total) * 100.0
    return percent, changed

# ---------------------------------------------------------------------------
# Event logging – JSON Lines
# ---------------------------------------------------------------------------
def ensure_log_dir():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.touch(exist_ok=True)

def log_event(event_type: str, baseline_id: str, diff_score: float, consecutive: int):
    """Append a single JSON line to the log file.

    The event schema matches the user specification.
    """
    ensure_log_dir()
    event = {
        "eventId": str(uuid.uuid4()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "type": event_type,
        "baselineId": baseline_id,
        "diffScore": diff_score,
        "consecutiveFrames": consecutive,
        "classification": "scene_changed",  # cannot reliably tell removal vs addition yet
    }
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")
    print(f"[EVENT] {event_type.upper()} emitted – diff {diff_score:.2f}% over {consecutive} frames")

# ---------------------------------------------------------------------------
# Main detection loop
# ---------------------------------------------------------------------------
def run_detector(endpoint: str, reset_baseline: bool = False):
    # Establish baseline – first successful capture
    baseline_img = None
    baseline_id = None
    while baseline_img is None:
        try:
            raw = fetch_frame(endpoint)
            baseline_img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if baseline_img is None:
                raise RuntimeError("Decode failure")
        except Exception as e:
            print(f"[WARN] Could not acquire baseline frame: {e}", file=sys.stderr)
            time.sleep(1.0)
    baseline_id = f"baseline-{datetime.utcnow().isoformat()}Z"
    print(f"Baseline captured – ID {baseline_id}")

    consecutive = 0
    event_emitted = False
    try:
        while True:
            try:
                raw = fetch_frame(endpoint)
                frame_img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame_img is None:
                    raise RuntimeError("Decode failure")
            except Exception as exc:
                print(f"[ERROR] Frame fetch/decode error: {exc}", file=sys.stderr)
                time.sleep(0.5)
                continue

            try:
                pct, changed = diff_percent(baseline_img, frame_img)
            except Exception as exc:
                print(f"[ERROR] Diff computation failed: {exc}", file=sys.stderr)
                continue

            if pct >= CAM_CHANGE_PERCENT:
                consecutive += 1
                print(f"[INFO] Change detected – {pct:.2f}% (consecutive {consecutive})")
                if not event_emitted and consecutive >= CAM_CONSECUTIVE_FRAMES:
                    log_event(
                        event_type="candidate_removal",
                        baseline_id=baseline_id,
                        diff_score=pct,
                        consecutive=consecutive,
                    )
                    event_emitted = True
            else:
                # Reset consecutive counter when scene stabilises
                if consecutive > 0:
                    print(f"[INFO] Scene returned below threshold ({pct:.2f}%). Resetting counter.")
                consecutive = 0

            # Simple sleep to respect roughly 1 fps; user can adjust via env var if needed
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nDetector stopped by user (Ctrl+C)")

# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def parse_args():
    parser = argparse.ArgumentParser(description="Standalone removal detector using ESP32-CAM.")
    parser.add_argument("--ip", help="IP address of the ESP32-CAM (overrides CAM_ENDPOINT env var)")
    parser.add_argument(
        "--reset-baseline",
        action="store_true",
        help="Force a new baseline capture before the detection loop starts",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=CAM_DIFF_THRESHOLD,
        help="Pixel intensity threshold for binary mask (default from env CAM_DIFF_THRESHOLD)",
    )
    parser.add_argument(
        "--percent",
        type=float,
        default=CAM_CHANGE_PERCENT,
        help="Percentage of changed pixels required to consider the frame different",
    )
    parser.add_argument(
        "--consecutive",
        type=int,
        default=CAM_CONSECUTIVE_FRAMES,
        help="Number of consecutive frames above the percent threshold before emitting an event",
    )
    return parser.parse_args()

def main():
    args = parse_args()
    # Override globals if CLI provides explicit values
    global CAM_DIFF_THRESHOLD, CAM_CHANGE_PERCENT, CAM_CONSECUTIVE_FRAMES, CAM_ENDPOINT
    if args.ip:
        CAM_ENDPOINT = f"http://{args.ip}/capture"
    CAM_DIFF_THRESHOLD = args.threshold
    CAM_CHANGE_PERCENT = args.percent
    CAM_CONSECUTIVE_FRAMES = args.consecutive

    run_detector(CAM_ENDPOINT, reset_baseline=args.reset_baseline)

if __name__ == "__main__":
    main()
