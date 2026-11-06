"""PHY-22 MOV reference values (Python 3 standard library only).

Run from this folder: python3 -I generate_mov_reference.py  ->  writes mov_reference.json (byte-identical on re-run).

Oracles (exact analytic derivations, grade A):
  1. Frame timeline: frames = floor(simDuration * fps / playbackRate + 1e-9) + 1, t_k = k * playbackRate / fps.
  2. Slider-crank piston (plans/mov_slider_crank_base.plan.json): r = 50 mm, l = 200 mm, omega = 100 rad/s,
     x(theta) = r cos(theta) + sqrt(l^2 - r^2 sin^2(theta)), theta = omega t.
  3. Spin clip (plans/mov_clip_spin.plan.json): box centre at 50 mm on +X rotates about Z through the origin at pi rad/s:
     centre_k = (50 cos(theta_k), 50 sin(theta_k)), theta_k = pi * k / fps.
  4. GIF delays: GIF89a stores delays in 1/100 s, so a frame k ends at floor(100 * (k + 1) / fps + 0.5) centiseconds; delay_k is the
     difference (cumulative error < 1 cs, never drifting).
"""

import json
import math


def g12(value):
    """12 significant digits, stable text (pack convention §6.3)."""
    return float(f"{value:.12g}")


def frame_count(sim_duration, fps, playback_rate):
    return math.floor(sim_duration * fps / playback_rate + 1e-9) + 1


def slider_crank():
    r, l, omega = 50.0, 200.0, 100.0
    sim_duration, fps, rate = 0.0628318530718, 30, 0.01
    count = frame_count(sim_duration, fps, rate)
    rows = []
    for k in range(0, count, 15):
        t = k * rate / fps
        theta = omega * t
        x = r * math.cos(theta) + math.sqrt(l * l - (r * math.sin(theta)) ** 2)
        rows.append({"frame": k, "tS": g12(t), "crankDeg": g12(math.degrees(theta)), "pistonXmm": g12(x)})
    return {"simDurationS": sim_duration, "fps": fps, "playbackRate": rate, "frames": count, "samples": rows}


def spin_clip():
    fps, duration, speed = 10, 2.0, math.pi
    count = math.floor(duration * fps + 1e-9) + 1
    rows = []
    for k in range(0, count, 5):
        theta = speed * k / fps
        rows.append({"frame": k, "angleRad": g12(theta), "centreMm": [g12(50 * math.cos(theta)), g12(50 * math.sin(theta))]})
    return {"fps": fps, "durationS": duration, "frames": count, "samples": rows}


def gif_delays(fps, count):
    ends = [math.floor(100 * (k + 1) / fps + 0.5) for k in range(count)]  # Math.round semantics (half up), not banker's rounding
    return [end - (ends[k - 1] if k > 0 else 0) for k, end in enumerate(ends)]


def main():
    reference = {
        "pack": "22-motion-video",
        "generatedBy": "generate_mov_reference.py",
        "sliderCrank": slider_crank(),
        "spinClip": spin_clip(),
        "gifDelaysCs": {"fps30": gif_delays(30, 12), "fps24": gif_delays(24, 12), "fps10": gif_delays(10, 4), "fps40": gif_delays(40, 8)},
    }
    with open("mov_reference.json", "w", encoding="utf-8", newline="\n") as out:
        json.dump(reference, out, indent=2)
        out.write("\n")


if __name__ == "__main__":
    main()
