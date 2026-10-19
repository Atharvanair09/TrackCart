import argparse
import os
import time
import urllib.request
import urllib.error
import socket
import statistics
from datetime import datetime

def main():
    parser = argparse.ArgumentParser(description="Capture JPEG frames from the ESP32-CAM.")
    parser.add_argument("--ip", required=True, help="IP address of the ESP32-CAM")
    parser.add_argument("--output", default="data/captured_images", help="Base output directory (default: data/captured_images)")
    parser.add_argument("--timeout", type=float, default=5.0, help="Timeout for HTTP requests in seconds (default: 5.0)")
    parser.add_argument("--fps", type=float, default=1.0, help="Target frames per second (default: 1.0)")
    parser.add_argument("--duration", type=float, default=None, help="Capture duration in seconds (optional)")
    parser.add_argument("--frames", type=int, default=None, help="Number of frames to capture (optional)")
    args = parser.parse_args()

    url = f"http://{args.ip}/capture"
    
    # Create a unique session directory
    session_id = f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    session_dir = os.path.join(args.output, session_id)
    
    try:
        os.makedirs(session_dir, exist_ok=False)
    except FileExistsError:
        print(f"Error: Session directory '{session_dir}' already exists. Refusing to overwrite.")
        return
    except OSError as e:
        print(f"Error: Failed to create session directory '{session_dir}'. Details: {e}")
        return

    print(f"Starting capture session: {session_id}")
    print(f"Target URL: {url}")
    print(f"Target FPS: {args.fps}")
    if args.duration:
        print(f"Target Duration: {args.duration} seconds")
    if args.frames:
        print(f"Target Frames: {args.frames}")
    print(f"Saving to: {session_dir}")
    print("Press Ctrl+C to stop.\n")

    frame_interval = 1.0 / args.fps
    
    metrics = {
        'requested': 0,
        'saved': 0,
        'failed': 0,
        'jpeg_validation_failed': 0,
        'total_bytes': 0,
        'request_durations': [],          # HTTP request durations for successful captures
        'request_durations_failed': [],   # HTTP request durations for failed attempts (timeout/conn error)
        'save_durations': [],             # Disk write durations for saved frames
        'jpeg_sizes_valid': [],           # Sizes in bytes of JPEG-valid bodies
        'jpeg_sizes_invalid': [],         # Sizes in bytes of bodies that failed JPEG validation
        'inter_frame_intervals': [],     # Elapsed time between consecutive request starts
        'scheduler_sleeps': [],           # Actual sleep durations slept by the scheduler
        'scheduler_skips': 0,            # Count of cycles where sleep_time <= 0 (skip)
    }

    session_start_time = time.time()
    session_perf_start = time.perf_counter()
    last_print_time = session_start_time
    last_request_start_perf = None

    try:
        while True:
            current_time = time.time()
            elapsed = current_time - session_start_time
            
            # Check limits
            if args.duration and elapsed >= args.duration:
                print(f"\nReached target duration ({args.duration}s). Stopping.")
                break
            if args.frames and metrics['requested'] >= args.frames:
                print(f"\nReached target frames ({args.frames}). Stopping.")
                break

            # Print periodic stats every 5 seconds
            if current_time - last_print_time >= 5.0:
                actual_fps = metrics['saved'] / elapsed if elapsed > 0 else 0
                avg_size = metrics['total_bytes'] / metrics['saved'] if metrics['saved'] > 0 else 0
                print(f"[{elapsed:.1f}s] Frames: {metrics['saved']}/{metrics['requested']} saved | "
                      f"Failed: {metrics['failed']} | Actual FPS: {actual_fps:.2f} | "
                      f"Avg Size: {avg_size/1024:.1f} KB")
                last_print_time = current_time

            metrics['requested'] += 1
            filename = f"frame_{metrics['saved'] + 1:06d}.jpg"
            filepath = os.path.join(session_dir, filename)

            request_start_perf = time.perf_counter()
            if last_request_start_perf is not None:
                metrics['inter_frame_intervals'].append(
                    request_start_perf - last_request_start_perf
                )
            last_request_start_perf = request_start_perf

            request_failed = False
            jpeg_valid = False
            jpeg_size = 0
            save_duration = 0.0

            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=args.timeout) as response:
                    if response.status == 200:
                        data = response.read()
                        request_end_perf = time.perf_counter()
                        metrics['request_durations'].append(
                            request_end_perf - request_start_perf
                        )
                        jpeg_size = len(data)
                        if data.startswith(b'\xff\xd8'):
                            save_start_perf = time.perf_counter()
                            with open(filepath, "wb") as f:
                                f.write(data)
                            save_duration = time.perf_counter() - save_start_perf
                            metrics['save_durations'].append(save_duration)
                            metrics['saved'] += 1
                            metrics['total_bytes'] += len(data)
                            metrics['jpeg_sizes_valid'].append(jpeg_size)
                            jpeg_valid = True
                        else:
                            metrics['failed'] += 1
                            metrics['jpeg_validation_failed'] += 1
                            metrics['jpeg_sizes_invalid'].append(jpeg_size)
                    else:
                        request_end_perf = time.perf_counter()
                        metrics['request_durations_failed'].append(
                            request_end_perf - request_start_perf
                        )
                        metrics['failed'] += 1
                        request_failed = True
            except (urllib.error.URLError, socket.timeout, ConnectionError):
                request_end_perf = time.perf_counter()
                metrics['request_durations_failed'].append(
                    request_end_perf - request_start_perf
                )
                metrics['failed'] += 1
                request_failed = True
            except OSError:
                request_end_perf = time.perf_counter()
                metrics['request_durations_failed'].append(
                    request_end_perf - request_start_perf
                )
                metrics['failed'] += 1
                request_failed = True

            # Scheduling: Wait for the next frame time
            next_frame_time = session_start_time + (metrics['requested'] * frame_interval)
            sleep_time = next_frame_time - time.time()
            if sleep_time > 0:
                metrics['scheduler_sleeps'].append(sleep_time)
                time.sleep(sleep_time)
            else:
                metrics['scheduler_skips'] += 1

    except KeyboardInterrupt:
        print("\nCapture interrupted by user (Ctrl+C).")

    # Final summary
    total_elapsed = time.time() - session_start_time
    actual_fps = metrics['saved'] / total_elapsed if total_elapsed > 0 else 0
    avg_size = metrics['total_bytes'] / metrics['saved'] if metrics['saved'] > 0 else 0

    print("\n--- Capture Session Summary ---")
    print(f"Session Dir:  {session_dir}")
    print(f"Elapsed Time: {total_elapsed:.2f} seconds")
    print(f"Frames Req:   {metrics['requested']}")
    print(f"Frames Saved: {metrics['saved']}")
    print(f"Frames Fail:  {metrics['failed']}")
    print(f"Actual FPS:   {actual_fps:.2f}")
    print(f"Requested FPS: {args.fps}")
    print(f"Avg JPEG:     {avg_size/1024:.1f} KB")

    # --- Diagnostic timing statistics ---

    def stat_summary(label, samples, unit="s", divisor=1):
        if not samples:
            print(f"{label}: no samples recorded")
            return
        vals = [v / divisor for v in samples]
        print(f"{label} ({unit}): "
              f"min={min(vals):.3f}  mean={statistics.mean(vals):.3f}  "
              f"median={statistics.median(vals):.3f}  max={max(vals):.3f}")

    print("\n--- Diagnostic Timings ---")
    stat_summary("Request dur (ok)", metrics['request_durations'])
    stat_summary("Request dur (failed)", metrics['request_durations_failed'])
    stat_summary("Save dur", metrics['save_durations'])
    stat_summary("Inter-frame", metrics['inter_frame_intervals'])
    stat_summary("JPEG size (valid)", metrics['jpeg_sizes_valid'], unit="KB", divisor=1024)
    stat_summary("JPEG size (invalid)", metrics['jpeg_sizes_invalid'], unit="KB", divisor=1024)
    stat_summary("Scheduler sleep", metrics['scheduler_sleeps'])

    print(f"Scheduler sleep skips: {metrics['scheduler_skips']}")
    print(f"JPEG validation failures: {metrics['jpeg_validation_failed']}")

    # Concise slowest-requests summary (top 5 by request duration, mixed ok/failed)
    all_req = [
        ("ok", d) for d in metrics['request_durations']
    ] + [
        ("fail", d) for d in metrics['request_durations_failed']
    ]
    if len(all_req) > 1:
        all_req.sort(key=lambda x: x[1], reverse=True)
        top_n = min(5, len(all_req))
        print(f"\nSlowest {top_n} requests:")
        for kind, dur in all_req[:top_n]:
            print(f"  {kind:4s} {dur:.3f}s")

if __name__ == "__main__":
    main()
