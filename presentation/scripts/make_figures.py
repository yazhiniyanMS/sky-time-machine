"""Build every raster asset the deck uses from real project outputs.

Inputs (all produced by this repository):
  assets/screens/*.png          headless-Firefox captures of the running app (scripts/capture_screens.mjs)
  assets/m31_gaussian.npz       M31 comparison re-run with the pre-0.2 PSF step (scripts/m31_psf_validation.py)
  assets/m31_epsf_cross.npz     same inputs with EPSF cross-convolution
  assets/m31_validation.json    measured numbers and the two on-grid EPSF kernels

Run from the repository root:
    .venv/bin/python presentation/scripts/make_figures.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from PIL import Image, ImageDraw, ImageFilter
from scipy.signal import fftconvolve

HERE = Path(__file__).resolve().parents[1]
A = HERE / "assets"
OUT = A / "build"
OUT.mkdir(exist_ok=True)
SCR = A / "screens"

BG = (5, 8, 14)
MASK_1, MASK_2 = (16, 21, 30), (11, 15, 22)  # checker for masked pixels, as in the app

# Diverging: blue (fading) <- neutral dark -> orange (brightening), the app's convention.
DIV = LinearSegmentedColormap.from_list(
    "div", [(0.0, "#9cc8ff"), (0.18, "#3987e5"), (0.5, "#151b26"), (0.82, "#d95926"), (1.0, "#ffc7a3")]
)
SEQ = LinearSegmentedColormap.from_list("seq", ["#05080e", "#0c3550", "#1f7fb0", "#5bc8f5", "#e6f7ff"])


def checker(h: int, w: int, cell: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = ((yy // cell + xx // cell) % 2).astype(bool)
    out = np.empty((h, w, 3), np.uint8)
    out[c] = MASK_1
    out[~c] = MASK_2
    return out


def upscale(rgb: np.ndarray, scale: int) -> np.ndarray:
    return np.kron(rgb, np.ones((scale, scale, 1), dtype=rgb.dtype))


def to_rgb(cmap, x: np.ndarray) -> np.ndarray:
    return (cmap(np.clip(x, 0, 1))[..., :3] * 255).astype(np.uint8)


def pixel_image(values: np.ndarray, cmap, lo: float, hi: float, scale: int = 12, rings=()) -> Image.Image:
    v = (values - lo) / (hi - lo)
    rgb = to_rgb(cmap, np.nan_to_num(v, nan=0.5))
    # FITS convention: row 0 at the bottom, so flip for display (north up, east left on a TAN grid).
    nan = np.isnan(values)[::-1]
    rgb = rgb[::-1]
    big = upscale(rgb, scale)
    chk = checker(big.shape[0], big.shape[1], max(3, scale // 3))
    big[upscale(nan[..., None].astype(np.uint8), scale)[..., 0].astype(bool)] = chk[
        upscale(nan[..., None].astype(np.uint8), scale)[..., 0].astype(bool)
    ]
    im = Image.fromarray(big)
    d = ImageDraw.Draw(im)
    h = values.shape[0]
    for y, x, r in rings:
        cy, cx = (h - 1 - y + 0.5) * scale, (x + 0.5) * scale
        rr = r * scale
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 255, 255), width=max(2, scale // 4))
    return im


def peak_rings(sig: np.ndarray, r: float = 3.6):
    """One ring around the +peak / -peak pair (a subtraction dipole when they are adjacent)."""
    (y1, x1), (y2, x2) = (np.unravel_index(f(sig), sig.shape) for f in (np.nanargmax, np.nanargmin))
    return [((y1 + y2) / 2, (x1 + x2) / 2, r + 0.5 * np.hypot(y1 - y2, x1 - x2))]


def m31_figures() -> None:
    g = np.load(A / "m31_gaussian.npz")
    e = np.load(A / "m31_epsf_cross.npz")
    # Epoch images: archive pixels on the common grid, shared asinh stretch.
    both = np.concatenate([g["a"][np.isfinite(g["a"])], g["b"][np.isfinite(g["b"])]])
    lo, hi = np.percentile(both, [0.5, 99.95])

    def stretch(x):
        y = np.arcsinh((x - lo) / ((hi - lo) * 0.12)) / np.arcsinh(1 / 0.12)
        return y

    gray = LinearSegmentedColormap.from_list("g", ["#04060a", "#3b4250", "#c9d2de", "#ffffff"])
    for k in ("a", "b"):
        pixel_image(stretch(g[k]), gray, 0, 1).save(OUT / f"m31_epoch_{k}.png")

    sg = np.where(g["valid"], g["significance"], np.nan)
    se = np.where(e["valid"], e["significance"], np.nan)
    pixel_image(sg, DIV, -10, 10, rings=peak_rings(sg)).save(OUT / "m31_sig_gaussian.png")
    y, x = np.unravel_index(np.nanargmax(np.abs(se)), se.shape)
    pixel_image(se, DIV, -10, 10, rings=[(y, x, 3.2)]).save(OUT / "m31_sig_epsf.png")

    # Colour bar strip for the significance maps (-10 .. +10 sigma).
    bar = np.linspace(0, 1, 1200)[None, :].repeat(28, 0)
    Image.fromarray(to_rgb(DIV, bar)).save(OUT / "sig_colorbar.png")

    # The two EPSF kernels on the comparison grid, and their cross-convolution (common PSF).
    v = json.loads((A / "m31_validation.json").read_text())["epsf_cross"]["psf"]
    ka, kb = np.array(v["psf_kernel_a"]), np.array(v["psf_kernel_b"])
    kc = fftconvolve(ka, kb)
    for name, k, sc in (("psf_a", ka, 60), ("psf_b", kb, 60), ("psf_common", kc, 32)):
        rgb = to_rgb(SEQ, np.sqrt(np.clip(k / k.max(), 0, 1)))[::-1]
        Image.fromarray(upscale(rgb, sc)).save(OUT / f"{name}.png")


def crop(name: str, box: tuple[int, int, int, int], out: str, width: int | None = None) -> None:
    im = Image.open(SCR / name).convert("RGB").crop(box)
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(OUT / out, quality=92)


def screens() -> None:
    # 3200 x 2000 captures (1600 x 1000 CSS px at 2x). Boxes are in capture pixels.
    crop("explore.png", (0, 300, 2480, 1695), "hero_explore.jpg")  # map only, below the search box
    crop("explore.png", (0, 0, 3200, 1880), "demo_explore.jpg", 2400)
    crop("compare.png", (0, 120, 3200, 1800), "demo_compare.jpg", 2800)
    crop("timeline.png", (232, 250, 2968, 845), "demo_timeline_strip.jpg", 2400)
    crop("timeline.png", (0, 120, 3200, 1450), "demo_timeline.jpg", 2400)
    crop("discovery.png", (120, 120, 3080, 2000), "demo_discovery.jpg", 2400)
    crop("spectra.png", (120, 120, 2370, 1340), "demo_spectra.jpg", 2000)

    # Title-slide scrim: opaque deck background on the left fading to clear on the right.
    w, h = 2400, 1350
    x = np.linspace(0, 1, w)
    alpha = np.clip(1.0 - (x - 0.18) / 0.55, 0, 1) ** 1.6 * 0.97
    a = np.tile((alpha * 255).astype(np.uint8), (h, 1))
    yb = np.linspace(0, 1, h)[:, None]
    a = np.maximum(a, (np.clip((yb - 0.72) / 0.28, 0, 1) ** 2 * 200).astype(np.uint8))
    rgba = np.dstack([np.full((h, w), c, np.uint8) for c in BG] + [a])
    Image.fromarray(rgba, "RGBA").filter(ImageFilter.GaussianBlur(2)).save(OUT / "hero_scrim.png")

    # Subtle star field for content-slide backgrounds (deterministic, sparse, faint).
    rng = np.random.default_rng(7)
    w, h = 2667, 1500
    img = np.zeros((h, w, 3), np.float32)
    img[:] = BG
    yy, xx = np.mgrid[0:h, 0:w]
    glow = np.exp(-(((xx - 0.85 * w) / (0.55 * w)) ** 2 + ((yy + 0.1 * h) / (0.7 * h)) ** 2))
    img += glow[..., None] * np.array([6, 14, 26], np.float32)
    n = 900
    ys, xs = rng.integers(0, h, n), rng.integers(0, w, n)
    br = rng.power(6, n) * 0.6 + 0.08
    for y, x, b in zip(ys, xs, br):
        img[y, x] = np.minimum(255, img[y, x] + 255 * b * np.array([0.85, 0.92, 1.0]))
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)).save(
        OUT / "bg_stars.jpg", quality=90
    )


if __name__ == "__main__":
    m31_figures()
    screens()
    for p in sorted(OUT.iterdir()):
        print(p.name, Image.open(p).size)
