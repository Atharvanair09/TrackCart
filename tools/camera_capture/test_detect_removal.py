#!/usr/bin/env python3
"""test_detect_removal.py – Offline verification of detect_removal logic.

This script re‑uses the `diff_percent` function from `detect_removal.py` to
compare three supplied image files (empty, added, removed).  It mimics the
consecutive‑frame logic by feeding the same comparison result multiple times.

Usage:
  python test_detect_removal.py --empty <path> --added <path> --removed <path>

The script prints a summary indicating whether a candidate removal would be
emitted for each transition according to the current configuration.
"""

import argparse
import os
import sys
from pathlib import Path

# Import diff_percent from the detector script (relative import)
import importlib.util

DETECTOR_PATH = Path(__file__).parent / "detect_removal.py"
spec = importlib.util.spec_from_file_location("detect_removal", str(DETECTOR_PATH))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

diff_percent = module.diff_percent

# Load configuration defaults from the detector module (environment vars may override)
CAM_CHANGE_PERCENT = getattr(module, "CAM_CHANGE_PERCENT", 2.0)
CAM_CONSECUTIVE_FRAMES = getattr(module, "CAM_CONSECUTIVE_FRAMES", 3)

def parse_args():
    parser = argparse.ArgumentParser(description="Offline test of removal detector logic.")
    parser.add_argument("--empty", required=True, help="Path to empty‑box image.")
    parser.add_argument("--added", required=True, help="Path to image with item added.")
    parser.add_argument("--removed", required=True, help="Path to image after item removal.")
    return parser.parse_args()

def simulate_transition(label, baseline_path, compare_path):
    baseline = module.cv2.imread(baseline_path)
    compare = module.cv2.imread(compare_path)
    if baseline is None or compare is None:
        print(f"[ERROR] Could not load images for {label}")
        return
    pct, changed = diff_percent(baseline, compare)
    print(f"{label}: diff {pct:.2f}% ({changed} pixels)")
    # Simulate consecutive‑frame check – we feed the same result `CAM_CONSECUTIVE_FRAMES` times
    if pct >= CAM_CHANGE_PERCENT:
        print(f"  -> exceeds change percent ({CAM_CHANGE_PERCENT}%). Simulating {CAM_CONSECUTIVE_FRAMES} consecutive frames…")
        # In a real run the detector would only emit after the required count.
        # Here we just report that it would have triggered.
        print(f"  => candidate_removal event WOULD be emitted")
    else:
        print(f"  -> below threshold – no event.")

def main():
    args = parse_args()
    simulate_transition("empty_vs_added", args.empty, args.added)
    simulate_transition("added_vs_removed", args.added, args.removed)
    simulate_transition("empty_vs_removed", args.empty, args.removed)

if __name__ == "__main__":
    main()
