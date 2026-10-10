import argparse
import os
import time
import urllib.request
import urllib.error
import socket
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
        'total_bytes': 0
    }

    session_start_time = time.time()
    last_print_time = session_start_time

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

            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=args.timeout) as response:
                    if response.status == 200:
                        data = response.read()
                        if data.startswith(b'\xff\xd8'):
                            with open(filepath, "wb") as f:
                                f.write(data)
                            metrics['saved'] += 1
                            metrics['total_bytes'] += len(data)
                        else:
                            metrics['failed'] += 1
                    else:
                        metrics['failed'] += 1
            except (urllib.error.URLError, socket.timeout, ConnectionError):
                metrics['failed'] += 1
            except OSError:
                metrics['failed'] += 1

            # Scheduling: Wait for the next frame time
            next_frame_time = session_start_time + (metrics['requested'] * frame_interval)
            sleep_time = next_frame_time - time.time()
            if sleep_time > 0:
                time.sleep(sleep_time)

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
    print(f"Avg JPEG:     {avg_size/1024:.1f} KB")

if __name__ == "__main__":
    main()
