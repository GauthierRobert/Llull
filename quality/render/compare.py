"""
Compare a llull render with its Cycles reference (RV1 §7 layer V3). System Python with numpy, OpenEXR and flip-evaluator
(`pip install -r quality/render/requirements.txt`).

    python3 quality/render/compare.py <reference.exr> <test.exr> [--flip-png out.png] [--side-by-side out.png]

Prints one JSON object:
- relError: luminance-weighted mean relative error, robust to fireflies:
      sum_p min(|Yt_p - Yr_p|, Yr_p + eps) / sum_p Yr_p,   eps = 0.1 x mean(Yr),   Y = Rec.709 luminance of the linear RGB.
  Weighting by luminance (dividing the summed absolute error by the summed reference) keeps dark pixels from dominating, and the clamp
  counts one firefly as at most a 100 % error (plus eps) at its pixel instead of letting it swamp the image mean.
- bias: sum Yt / sum Yr - 1 (signed; a radiometry or energy error shows here first), and biasRgb per channel.
- flip: mean HDR-FLIP (NVIDIA FLIP 1.x, flip-evaluator, default 67 pixels per degree, automatic exposure range) on the linear RGB.
- meanReference / meanTest: mean luminance of each image.
"""

import json
import sys

import flip_evaluator
import numpy as np
import OpenEXR

LUMINANCE = np.array([0.2126, 0.7152, 0.0722])


def read_rgb(path):
    with OpenEXR.File(path, separate_channels=True) as exr:
        channels = exr.channels()
        rgb = np.stack([np.asarray(channels[name].pixels, dtype=np.float64) for name in ('R', 'G', 'B')], axis=-1)
    rgb = np.nan_to_num(rgb, nan=0.0, posinf=0.0, neginf=0.0)
    return np.maximum(rgb, 0.0)


def metrics(reference, test):
    if reference.shape != test.shape:
        raise SystemExit(f'size mismatch: reference {reference.shape} vs test {test.shape}')
    yr = reference @ LUMINANCE
    yt = test @ LUMINANCE
    total = float(yr.sum())
    eps = 0.1 * float(yr.mean())
    rel = float(np.minimum(np.abs(yt - yr), yr + eps).sum() / total) if total > 0 else float('inf')
    bias_rgb = [float(test[..., c].sum() / reference[..., c].sum() - 1.0) if reference[..., c].sum() > 0 else 0.0 for c in range(3)]
    flip_map, flip_mean, _ = flip_evaluator.evaluate(
        reference.astype(np.float32), test.astype(np.float32), 'HDR', inputsRGB=False, applyMagma=True, computeMeanError=True
    )
    return {
        'relError': rel,
        'bias': float(yt.sum() / total - 1.0) if total > 0 else 0.0,
        'biasRgb': bias_rgb,
        'flip': float(flip_mean),
        'meanReference': float(yr.mean()),
        'meanTest': float(yt.mean()),
    }, flip_map


def display(rgb, scale):
    """Exposure so the reference mean luminance sits at 0.18, a Reinhard curve, then the sRGB encoding (for looking only)."""
    x = rgb * scale
    x = x / (1.0 + x @ LUMINANCE)[..., None]
    x = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055)
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


def side_by_side(reference, test, flip_map, target):
    from PIL import Image  # optional: only for the diagnostic pictures

    scale = 0.18 / max(float((reference @ LUMINANCE).mean()), 1e-12)
    flip_rgb = np.clip(np.asarray(flip_map) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(np.concatenate([display(reference, scale), display(test, scale), flip_rgb], axis=1)).save(target)


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        raise SystemExit('usage: compare.py <reference.exr> <test.exr> [--flip-png out.png] [--side-by-side out.png]')
    reference, test = read_rgb(args[0]), read_rgb(args[1])
    result, flip_map = metrics(reference, test)
    if '--flip-png' in args:
        from PIL import Image  # optional: only for the diagnostic map

        target = args[args.index('--flip-png') + 1]
        Image.fromarray(np.clip(np.asarray(flip_map) * 255.0 + 0.5, 0, 255).astype(np.uint8)).save(target)
    if '--side-by-side' in args:
        side_by_side(reference, test, flip_map, args[args.index('--side-by-side') + 1])
    sys.stdout.write(json.dumps(result) + '\n')


main()
