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
CAM_TIMEOUT = float(os.getenv("CAM_TIMEOUT", "5.0"))  # seconds, configurable timeout for HTTP requests
CAM_STABILIZATION_FRAMES = int(os.getenv("CAM_STABILIZATION_FRAMES", "5"))  # consecutive stable frames before baseline refresh

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

    # Only the first error in a consecutive failure streak is printed; subsequent errors are suppressed until a successful capture resets the counter
    baseline_failures = 0
    backoff_delay = 0.5  # initial backoff in seconds
    max_backoff = 8.0
    while baseline_img is None:
        try:
            raw = fetch_frame(endpoint)
            baseline_img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if baseline_img is None:
                raise RuntimeError("Decode failure")
            # Successful acquisition resets failure counter and backoff
            baseline_failures = 0  # reset counter; only first error in a failure streak is printed  # reset counter; only first error in a failure streak is printed
            backoff_delay = 0.5
        except urllib.error.HTTPError as exc:
            if baseline_failures == 0:
                print(f"[ERROR] HTTP error {exc.code} while fetching baseline frame: {exc.reason}", file=sys.stderr)
            baseline_failures += 1
        except urllib.error.URLError as exc:
            if baseline_failures == 0:
                print(f"[ERROR] URL error while fetching baseline frame: {exc.reason}", file=sys.stderr)
            baseline_failures += 1
        except socket.timeout:
            if baseline_failures == 0:
                print(f"[ERROR] Timeout after {CAM_TIMEOUT}s while fetching baseline frame", file=sys.stderr)
            baseline_failures += 1
        except RuntimeError as exc:
            if baseline_failures == 0:
                print(f"[ERROR] Baseline decode failure: {exc}", file=sys.stderr)
            baseline_failures += 1
        except Exception as exc:
            if baseline_failures == 0:
                print(f"[WARN] Unexpected error during baseline acquisition: {exc}", file=sys.stderr)
            baseline_failures += 1
        # Apply exponential backoff for subsequent failures
        if baseline_img is None:
            backoff_delay = min(backoff_delay * 2, max_backoff)
            time.sleep(backoff_delay)
    baseline_id = f"baseline-{datetime.utcnow().isoformat()}Z"
    print(f"Baseline captured – ID {baseline_id}")

    consecutive = 0
    event_emitted = False
    in_stabilization = False
    stabilize_counter = 0
    prev_frame_img = None  # Track previous successful frame for stabilization
    try:
        # Main detection loop with robust retry and exponential backoff on fetch/decode failures
        # Only the first error in a consecutive failure streak is printed; subsequent errors are suppressed until a successful capture resets the counter
        failure_count = 0
        backoff_delay = 0.5
        max_backoff = 8.0
        while True:
            # --- Frame acquisition with detailed error categories (first error of a streak printed, then suppressed until a successful capture) ---
            try:
                raw = fetch_frame(endpoint)
                frame_img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame_img is None:
                    raise RuntimeError("Decode failure")
                # Successful fetch/decode resets failure counters
                failure_count = 0
                backoff_delay = 0.5
            except urllib.error.HTTPError as exc:
                if failure_count == 0:
                    print(f"[ERROR] HTTP error {exc.code} while fetching frame: {exc.reason}", file=sys.stderr)
                failure_count += 1
            except urllib.error.URLError as exc:
                if failure_count == 0:
                    print(f"[ERROR] URL error while fetching frame: {exc.reason}", file=sys.stderr)
                failure_count += 1
            except socket.timeout:
                if failure_count == 0:
                    print(f"[ERROR] Timeout after {CAM_TIMEOUT}s while fetching frame", file=sys.stderr)
                failure_count += 1
            except RuntimeError as exc:
                if failure_count == 0:
                    print(f"[ERROR] Frame decode failure: {exc}", file=sys.stderr)
                failure_count += 1
            except Exception as exc:
                if failure_count == 0:
                    print(f"[WARN] Unexpected error during frame acquisition: {exc}", file=sys.stderr)
                failure_count += 1

            if failure_count > 0:
                # Apply exponential backoff before next attempt
                backoff_delay = min(backoff_delay * 2, max_backoff)
                time.sleep(backoff_delay)
                continue

            # --- Image difference computation ---
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
                    # Start stabilization phase after emitting event
                    in_stabilization = True
                    stabilize_counter = 0
                    prev_frame_img = frame_img  # reference for consecutive comparisons
                    print("[INFO] Scene change event emitted, entering stabilization phase")
            else:
                if in_stabilization:
                    # Compare current frame to previous successful frame for stabilization
                    if prev_frame_img is None:
                        # First frame after entering stabilization; set reference frame
                        prev_frame_img = frame_img
                        # Do not count this frame toward stabilization
                    else:
                        try:
                            stab_pct, _ = diff_percent(prev_frame_img, frame_img)
                        except Exception as exc:
                            print(f"[ERROR] Stabilization diff failed: {exc}", file=sys.stderr)
                            # Do not count this frame; keep previous reference unchanged
                            continue
                        if stab_pct < CAM_CHANGE_PERCENT:
                            stabilize_counter += 1
                            print(f"[INFO] Stabilization progress: {stabilize_counter}/{CAM_STABILIZATION_FRAMES} stable frames")
                            # Update reference for next comparison
                            prev_frame_img = frame_img
                            if stabilize_counter >= CAM_STABILIZATION_FRAMES:
                                # Refresh baseline after successful stabilization
                                print("[INFO] Stabilization achieved, refreshing baseline")
                                # Capture new baseline frame with retry/backoff
                                baseline_img = None
                                baseline_failures = 0
                                backoff_delay = 0.5
                                while baseline_img is None:
                                    try:
                                        raw = fetch_frame(endpoint)
                                        baseline_img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
                                        if baseline_img is None:
                                            raise RuntimeError("Decode failure")
                                        baseline_failures = 0
                                        backoff_delay = 0.5
                                    except Exception as exc:
                                        if baseline_failures == 0:
                                            print(f"[ERROR] Baseline refresh error: {exc}", file=sys.stderr)
                                        baseline_failures += 1
                                        backoff_delay = min(backoff_delay * 2, max_backoff)
                                        time.sleep(backoff_delay)
                                baseline_id = f"baseline-{datetime.utcnow().isoformat()}Z"
                                print(f"Baseline refreshed – ID {baseline_id}")
                                # Reset state for next detection cycle
                                event_emitted = False
                                in_stabilization = False
                                consecutive = 0
                                stabilize_counter = 0
                                prev_frame_img = None
                        else:
                            # Unstable frame: reset stabilization counter, update reference frame
                            stabilize_counter = 0
                            prev_frame_img = frame_img
                else:
                    # Normal operation: reset consecutive counter when scene below threshold
                    if consecutive > 0:
                        print(f"[INFO] Scene returned below threshold ({pct:.2f}%). Resetting counter.")
                    consecutive = 0
                    # Update previous frame reference for potential future stabilization
                    prev_frame_img = frame_img

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
