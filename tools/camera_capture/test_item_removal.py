"""
test_item_removal.py -- Offline three-state test of whether OpenCV image
comparison can detect an item being added to and then removed from a shoebox.

Usage
-----
python test_item_removal.py --empty <path> --added <path> --removed <path>
                            [--threshold N]

Arguments
---------
  --empty       Image of the empty shoebox before adding the item.
  --added       Image of the same shoebox with the item inside.
  --removed     Image after the item has been removed.
  --threshold   Integer 0-255; pixels with diff above this value are marked as
                changed. Default: 30.

Outputs
-------
A subfolder named ``item_removal_test_results`` is created next to the
``--removed`` image.  For each of the three comparisons the following files
are written:

  <name>_diff.jpg     Grayscale absolute-difference image.
  <name>_mask.jpg     Cleaned binary mask (after morphological open+close).
  <name>_outline.jpg  Second image of the pair with significant contours drawn.

Comparisons
-----------
  empty_vs_added   -- empty vs. added   (detect the item being placed in)
  added_vs_removed -- added vs. removed  (detect the item being taken out)
  empty_vs_removed -- empty vs. removed   (check scene returned to ~original)

No file is overwritten: if an output already exists the script prints an
error and exits with a non-zero status.

This is an offline experiment for three captured states -- it does not prove
reliable real-time detection.
"""

import argparse
import os
import sys

import cv2


# ── argument parsing ─────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Offline three-state test of OpenCV item-add / item-remove "
            "detection for a shoebox."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--empty",
        required=True,
        help="Image of the empty shoebox before adding the item.",
    )
    parser.add_argument(
        "--added",
        required=True,
        help="Image of the same shoebox with the item inside.",
    )
    parser.add_argument(
        "--removed",
        required=True,
        help="Image after the item has been removed.",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=30,
        metavar="N",
        help="Pixel-difference threshold (0-255). "
             "Pixels above this are marked as changed. Default: 30.",
    )
    return parser.parse_args()


# ── helpers ──────────────────────────────────────────────────────────

def load_image(path, label):
    """Load an image from disk; exit with a clear message on failure."""
    if not os.path.isfile(path):
        sys.exit(f"Error: {label} image not found: {path}")
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"Error: OpenCV could not decode {label} image: {path}")
    return img


def validate_dimensions(name_a, img_a, name_b, img_b):
    """Exit with a clear message if two images differ in size or channels."""
    if img_a.shape != img_b.shape:
        sys.exit(
            f"Error: {name_a} and {name_b} have different dimensions.\n"
            f"  {name_a}: {img_a.shape[1]}x{img_a.shape[0]} "
            f"(channels={img_a.shape[2] if img_a.ndim == 3 else 1})\n"
            f"  {name_b}: {img_b.shape[1]}x{img_b.shape[0]} "
            f"(channels={img_b.shape[2] if img_b.ndim == 3 else 1})"
        )


def safe_write(path, img):
    """Write an image to disk, refusing to overwrite an existing file."""
    if os.path.exists(path):
        sys.exit(
            f"Error: output file already exists (will not overwrite): {path}"
        )
    ok = cv2.imwrite(path, img)
    if not ok:
        sys.exit(f"Error: could not write output file: {path}")


# ── core comparison ──────────────────────────────────────────────────

def compare(label, img_a, img_b, threshold, out_dir):
    """Run a single grayscale absdiff comparison.

    Parameters
    ----------
    label     : identifier used in output filenames (e.g. "empty_vs_added").
    img_a     : first image (BGR) -- the "before" in the pair.
    img_b     : second image (BGR) -- the "after" in the pair.  Outlines are
                drawn on a copy of this image.
    threshold : binary threshold value (0-255).
    out_dir   : directory to write outputs into.

    Returns a dict of measurements.
    """
    # Grayscale conversion
    gray_a = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)

    # Absolute pixel-wise difference
    diff = cv2.absdiff(gray_a, gray_b)

    # Binary threshold mask
    _, mask = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)

    # 3x3 morphological opening then closing (same approach as
    # compare_images.py: opening removes small isolated blobs, closing
    # fills small holes inside larger regions).
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask_clean = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask_clean = cv2.morphologyEx(mask_clean, cv2.MORPH_CLOSE, kernel)

    # External contours, keep those with area >= 100 px
    contours, _ = cv2.findContours(
        mask_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    significant = [c for c in contours if cv2.contourArea(c) >= 100]

    # Draw outlines on a copy of the second image in this comparison
    outlined = img_b.copy()
    cv2.drawContours(outlined, significant, -1, (0, 255, 0), 2)  # green

    # Output paths
    path_diff = os.path.join(out_dir, f"{label}_diff.jpg")
    path_mask = os.path.join(out_dir, f"{label}_mask.jpg")
    path_outline = os.path.join(out_dir, f"{label}_outline.jpg")

    safe_write(path_diff, diff)
    safe_write(path_mask, mask_clean)
    safe_write(path_outline, outlined)

    # Measurements (denominator = total image pixels)
    h, w = gray_a.shape[:2]
    total_pixels = h * w
    changed = int(cv2.countNonZero(mask_clean))
    pct = (changed / total_pixels) * 100

    return {
        "label": label,
        "changed": changed,
        "total": total_pixels,
        "pct": pct,
        "num_contours": len(contours),
        "num_significant": len(significant),
        "path_diff": path_diff,
        "path_mask": path_mask,
        "path_outline": path_outline,
    }


# ── report ───────────────────────────────────────────────────────────

def print_report(result):
    """Print a readable block for one comparison."""
    print(f"\n  --- {result['label']} ---")
    print(
        f"    Changed pixels:      {result['changed']:,} / "
        f"{result['total']:,}  ({result['pct']:.2f}%)"
    )
    print(
        f"    Significant contours (>= 100 px²): "
        f"{result['num_significant']} of {result['num_contours']}"
    )
    print(f"    Diff image:          {result['path_diff']}")
    print(f"    Mask image:          {result['path_mask']}")
    print(f"    Outline image:       {result['path_outline']}")


# ── main ─────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    if not (0 <= args.threshold <= 255):
        sys.exit(
            f"Error: --threshold must be between 0 and 255 "
            f"(got {args.threshold})."
        )

    # ------------------------------------------------------------------
    # 1. Load all three images
    # ------------------------------------------------------------------
    empty = load_image(args.empty, "empty")
    added = load_image(args.added, "added")
    removed = load_image(args.removed, "removed")

    # ------------------------------------------------------------------
    # 2. Validate dimensions match across all three
    # ------------------------------------------------------------------
    validate_dimensions("empty", empty, "added", added)
    validate_dimensions("added", added, "removed", removed)

    # ------------------------------------------------------------------
    # 3. Output directory: item_removal_test_results next to --removed
    # ------------------------------------------------------------------
    removed_dir = os.path.dirname(os.path.abspath(args.removed))
    out_dir = os.path.join(removed_dir, "item_removal_test_results")
    os.makedirs(out_dir, exist_ok=True)

    threshold = args.threshold

    # ------------------------------------------------------------------
    # 4. Run the three independent comparisons
    # ------------------------------------------------------------------
    results = []
    results.append(compare("empty_vs_added", empty, added, threshold, out_dir))
    results.append(compare("added_vs_removed", added, removed, threshold, out_dir))
    results.append(compare("empty_vs_removed", empty, removed, threshold, out_dir))

    # ------------------------------------------------------------------
    # 5. Summary report
    # ------------------------------------------------------------------
    print()
    print("=" * 60)
    print("ITEM REMOVAL TEST -- SUMMARY")
    print("=" * 60)
    print(f"  Empty:     {os.path.abspath(args.empty)}")
    print(f"  Added:     {os.path.abspath(args.added)}")
    print(f"  Removed:   {os.path.abspath(args.removed)}")
    print(f"  Threshold: {threshold}")
    print(f"  Output:    {out_dir}")

    for r in results:
        print_report(r)

    # ------------------------------------------------------------------
    # 6. Interpretation guide
    # ------------------------------------------------------------------
    print()
    print("=" * 60)
    print("INTERPRETATION GUIDE")
    print("=" * 60)
    print("""
  empty_vs_added:
    Should show a clear change around the item that was placed in the box.
    Expect a higher changed-pixel percentage and one or more significant
    contours near the item's location.

  added_vs_removed:
    Should show a clear change around the item's former position.  The
    change pattern should roughly mirror empty_vs_added if the item was
    returned to approximately the same spot outside the box.

  empty_vs_removed:
    Should generally show LESS change than the other two comparisons,
    because the scene returned to (approximately) its original state.
    Residual change here typically indicates lighting drift, camera
    movement, or the item leaving a mark or shifting the box.

  NOTE: These measurements are from a single offline experiment with
  three captured states.  They do not prove reliable real-time detection.
  A production system would need many samples under varying conditions
  and validated thresholds before deployment.
""")


if __name__ == "__main__":
    main()
