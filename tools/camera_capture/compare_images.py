"""
compare_images.py -- Pixel-level diff between two JPEG frames from the ESP32-CAM.

Usage
-----
python compare_images.py <baseline> <comparison> [--threshold N]

Arguments
---------
  baseline      Path to the reference image (e.g. frame_000001.jpg).
  comparison    Path to the image being compared against the baseline.
  --threshold   Integer 0-255; pixels with diff above this value are marked as
                changed. Default: 30.

Outputs (written beside <comparison>)
--------------------------------------
  <stem>_diff.jpg          Grayscale absolute-difference image (raw, never modified).
  <stem>_mask.jpg          Raw binary threshold mask (white = changed, black = unchanged).
  <stem>_mask_clean.jpg    Cleaned mask after morphological opening + closing (noise removed).
  <stem>_outline.jpg       Comparison image with cleaned regions outlined in green
                           (contours < 100 px² are ignored).

  [EXPERIMENTAL -- CLAHE pre-processing]
  <stem>_clahe_diff.jpg    Difference after CLAHE equalisation (clipLimit=2.0, tile=8x8).
  <stem>_clahe_mask.jpg    Threshold + morphological-cleaned mask from the CLAHE diff.
  <stem>_clahe_outline.jpg Comparison image with CLAHE-pipeline regions outlined in blue.

  [EXPERIMENTAL -- Global brightness normalisation]
  <stem>_norm_diff.jpg     Difference after scaling comparison by baseline_median/comp_median.
  <stem>_norm_mask.jpg     Threshold + morphological-cleaned mask from the normalised diff.
  <stem>_norm_outline.jpg  Comparison image with normalised-pipeline regions outlined in red.

Example
-------
  python compare_images.py data/captured_images/session_20261015_215034/frame_000001.jpg \\
                           data/captured_images/session_20261015_215034/frame_000300.jpg \\
                           --threshold 30
"""

import argparse
import os
import sys

import cv2


def parse_args():
    parser = argparse.ArgumentParser(
        description="Compare two images pixel-wise using OpenCV.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("baseline", help="Path to the baseline (reference) image.")
    parser.add_argument("comparison", help="Path to the comparison image.")
    parser.add_argument(
        "--threshold",
        type=int,
        default=30,
        metavar="N",
        help="Pixel-difference threshold (0-255). Pixels above this are marked as "
             "changed. Default: 30.",
    )
    return parser.parse_args()


def load_image(path, label):
    """Load an image from disk; exit with a clear message on failure."""
    if not os.path.isfile(path):
        sys.exit(f"Error: {label} file not found: {path}")
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"Error: OpenCV could not decode {label} image: {path}")
    return img


def output_path(comparison_path, suffix):
    """Build an output path beside the comparison image with a new suffix."""
    directory = os.path.dirname(os.path.abspath(comparison_path))
    stem = os.path.splitext(os.path.basename(comparison_path))[0]
    return os.path.join(directory, f"{stem}{suffix}")


def main():
    args = parse_args()

    if not (0 <= args.threshold <= 255):
        sys.exit(f"Error: --threshold must be between 0 and 255 (got {args.threshold}).")

    # ------------------------------------------------------------------
    # 1. Load images
    # ------------------------------------------------------------------
    baseline = load_image(args.baseline, "baseline")
    comparison = load_image(args.comparison, "comparison")

    # ------------------------------------------------------------------
    # 2. Validate dimensions match
    # ------------------------------------------------------------------
    if baseline.shape != comparison.shape:
        sys.exit(
            f"Error: Image dimensions differ.\n"
            f"  baseline:   {baseline.shape[1]}x{baseline.shape[0]}\n"
            f"  comparison: {comparison.shape[1]}x{comparison.shape[0]}"
        )

    h, w = baseline.shape[:2]
    total_pixels = h * w

    # ------------------------------------------------------------------
    # 3. Grayscale conversion
    # ------------------------------------------------------------------
    gray_base = cv2.cvtColor(baseline, cv2.COLOR_BGR2GRAY)
    gray_comp = cv2.cvtColor(comparison, cv2.COLOR_BGR2GRAY)

    # ------------------------------------------------------------------
    # 4. Absolute pixel-wise difference
    # ------------------------------------------------------------------
    diff = cv2.absdiff(gray_base, gray_comp)

    # ------------------------------------------------------------------
    # 5. Binary threshold mask (raw -- never modified, saved as-is)
    # ------------------------------------------------------------------
    _, mask = cv2.threshold(diff, args.threshold, 255, cv2.THRESH_BINARY)

    # ------------------------------------------------------------------
    # 5a. Morphological cleaning to remove isolated noise and fill gaps
    #     Opening  (erode then dilate) removes small isolated foreground blobs.
    #     Closing  (dilate then erode) fills small holes inside larger regions.
    # ------------------------------------------------------------------
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask_clean = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel)
    mask_clean = cv2.morphologyEx(mask_clean, cv2.MORPH_CLOSE, kernel)

    # ------------------------------------------------------------------
    # 6. Outline changed regions using the cleaned mask;
    #    skip contours whose area is smaller than 100 pixels.
    # ------------------------------------------------------------------
    contours, _ = cv2.findContours(mask_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    significant = [c for c in contours if cv2.contourArea(c) >= 100]
    outlined = comparison.copy()
    cv2.drawContours(outlined, significant, -1, (0, 255, 0), 2)  # green outlines

    # ------------------------------------------------------------------
    # 7. Save outputs
    # ------------------------------------------------------------------
    path_diff       = output_path(args.comparison, "_diff.jpg")
    path_mask       = output_path(args.comparison, "_mask.jpg")
    path_mask_clean = output_path(args.comparison, "_mask_clean.jpg")
    path_outline    = output_path(args.comparison, "_outline.jpg")

    cv2.imwrite(path_diff,       diff)
    cv2.imwrite(path_mask,       mask)
    cv2.imwrite(path_mask_clean, mask_clean)
    cv2.imwrite(path_outline,    outlined)

    # ------------------------------------------------------------------
    # 8. Report
    #    Raw percentage uses the unmodified threshold mask.
    #    Cleaned percentage uses the morphologically processed mask.
    # ------------------------------------------------------------------
    raw_changed     = int(cv2.countNonZero(mask))
    cleaned_changed = int(cv2.countNonZero(mask_clean))
    raw_pct         = (raw_changed     / total_pixels) * 100
    cleaned_pct     = (cleaned_changed / total_pixels) * 100

    print(f"Baseline:              {os.path.abspath(args.baseline)}")
    print(f"Comparison:            {os.path.abspath(args.comparison)}")
    print(f"Threshold:             {args.threshold}")
    print(f"Resolution:            {w}x{h}  ({total_pixels:,} pixels)")
    print(f"Changed (raw mask):    {raw_changed:,} / {total_pixels:,}  ({raw_pct:.2f}%)")
    print(f"Changed (clean mask):  {cleaned_changed:,} / {total_pixels:,}  ({cleaned_pct:.2f}%)")
    print(f"Contours drawn:        {len(significant)} of {len(contours)} (>= 100 px²)")
    print()
    print(f"Saved diff:            {path_diff}")
    print(f"Saved mask (raw):      {path_mask}")
    print(f"Saved mask (clean):    {path_mask_clean}")
    print(f"Saved outline:         {path_outline}")

    # ------------------------------------------------------------------
    # EXPERIMENTAL: CLAHE-based lighting-robust comparison
    #
    # Contrast Limited Adaptive Histogram Equalisation (CLAHE) normalises
    # local contrast independently in each tile, which can reduce the
    # apparent pixel-level difference caused by a uniform lighting change
    # while preserving edges (e.g. the bottle outline).
    #
    # This is an experiment: we make no claim it solves lighting sensitivity.
    # All existing outputs and statistics above are unaffected.
    # ------------------------------------------------------------------
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    clahe_base = clahe.apply(gray_base)
    clahe_comp = clahe.apply(gray_comp)

    clahe_diff = cv2.absdiff(clahe_base, clahe_comp)

    _, clahe_mask = cv2.threshold(clahe_diff, args.threshold, 255, cv2.THRESH_BINARY)

    # Same 3x3 morphological opening + closing as the standard cleaned mask.
    clahe_mask = cv2.morphologyEx(clahe_mask, cv2.MORPH_OPEN,  kernel)
    clahe_mask = cv2.morphologyEx(clahe_mask, cv2.MORPH_CLOSE, kernel)

    clahe_contours, _ = cv2.findContours(
        clahe_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    clahe_significant = [c for c in clahe_contours if cv2.contourArea(c) >= 100]
    clahe_outlined = comparison.copy()
    cv2.drawContours(clahe_outlined, clahe_significant, -1, (255, 0, 0), 2)  # blue outlines

    path_clahe_diff    = output_path(args.comparison, "_clahe_diff.jpg")
    path_clahe_mask    = output_path(args.comparison, "_clahe_mask.jpg")
    path_clahe_outline = output_path(args.comparison, "_clahe_outline.jpg")

    cv2.imwrite(path_clahe_diff,    clahe_diff)
    cv2.imwrite(path_clahe_mask,    clahe_mask)
    cv2.imwrite(path_clahe_outline, clahe_outlined)

    clahe_changed = int(cv2.countNonZero(clahe_mask))
    clahe_pct     = (clahe_changed / total_pixels) * 100

    print()
    print("-- EXPERIMENTAL (CLAHE clipLimit=2.0, tile=8x8) --")
    print(f"Changed (CLAHE mask):  {clahe_changed:,} / {total_pixels:,}  ({clahe_pct:.2f}%)")
    print(f"Contours drawn:        {len(clahe_significant)} of {len(clahe_contours)} (>= 100 px²)")
    print()
    print(f"Saved CLAHE diff:      {path_clahe_diff}")
    print(f"Saved CLAHE mask:      {path_clahe_mask}")
    print(f"Saved CLAHE outline:   {path_clahe_outline}")

    # ------------------------------------------------------------------
    # EXPERIMENTAL: Global brightness normalisation
    #
    # Scales the comparison grayscale image so its median brightness
    # matches the baseline median, then diffs against the baseline.
    # A uniform lighting change shifts every pixel by roughly the same
    # multiplicative factor, so this scaling may cancel much of that
    # global shift while preserving local structure (e.g. a bottle edge).
    #
    # This is an experiment: we make no claim it solves lighting
    # sensitivity. All existing outputs and statistics above are unaffected.
    # ------------------------------------------------------------------
    base_median = float(cv2.medianBlur(gray_base, 1).ravel().mean())
    # medianBlur with ksize=1 is a no-op; use numpy via the standard library
    # alternative: sort via cv2 is unavailable, so compute with a simple
    # Python approach on the already-imported array.
    import numpy as _np  # numpy is a cv2 transitive dependency; no new install
    base_median = float(_np.median(gray_base))
    comp_median = float(_np.median(gray_comp))

    print()
    print("-- EXPERIMENTAL (Global brightness normalisation) --")
    print(f"Baseline median:       {base_median:.1f}")
    print(f"Comparison median:     {comp_median:.1f}")

    if comp_median == 0:
        print("Normalisation skipped: comparison median is zero (cannot divide by zero).")
        print("No norm outputs saved.")
    else:
        scale_factor = base_median / comp_median
        print(f"Scale factor:          {scale_factor:.4f}")

        # Scale the comparison; clip to [0, 255] via convertScaleAbs.
        # gray_comp is NOT modified.
        gray_comp_norm = cv2.convertScaleAbs(gray_comp, alpha=scale_factor, beta=0)

        norm_diff = cv2.absdiff(gray_base, gray_comp_norm)

        _, norm_mask = cv2.threshold(norm_diff, args.threshold, 255, cv2.THRESH_BINARY)

        # Same 3x3 morphological opening + closing as both other pipelines.
        norm_mask = cv2.morphologyEx(norm_mask, cv2.MORPH_OPEN,  kernel)
        norm_mask = cv2.morphologyEx(norm_mask, cv2.MORPH_CLOSE, kernel)

        norm_contours, _ = cv2.findContours(
            norm_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        norm_significant = [c for c in norm_contours if cv2.contourArea(c) >= 100]
        norm_outlined = comparison.copy()
        cv2.drawContours(norm_outlined, norm_significant, -1, (0, 0, 255), 2)  # red outlines

        path_norm_diff    = output_path(args.comparison, "_norm_diff.jpg")
        path_norm_mask    = output_path(args.comparison, "_norm_mask.jpg")
        path_norm_outline = output_path(args.comparison, "_norm_outline.jpg")

        cv2.imwrite(path_norm_diff,    norm_diff)
        cv2.imwrite(path_norm_mask,    norm_mask)
        cv2.imwrite(path_norm_outline, norm_outlined)

        norm_changed = int(cv2.countNonZero(norm_mask))
        norm_pct     = (norm_changed / total_pixels) * 100

        print(f"Changed (norm mask):   {norm_changed:,} / {total_pixels:,}  ({norm_pct:.2f}%)")
        print(f"Contours drawn:        {len(norm_significant)} of {len(norm_contours)} (>= 100 px²)")
        print()
        print(f"Saved norm diff:       {path_norm_diff}")
        print(f"Saved norm mask:       {path_norm_mask}")
        print(f"Saved norm outline:    {path_norm_outline}")


if __name__ == "__main__":
    main()
