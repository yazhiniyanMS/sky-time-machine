"""Minimal categorical-palette check (OKLab ΔE×100 under normal vision and simulated CVD).

Usage: python check_palette.py "#hex,#hex,..." "#surface" [--adjacent]
Pairs: every pair by default; --adjacent checks neighbours only (ordinal series such as detectors D1-D6,
which are always labelled and ordered by wavelength).
Pass: normal ΔE ≥ 15, CVD ΔE ≥ 8 (6–8 only with secondary encoding), contrast vs surface ≥ 3:1 for marks.
CVD matrices: Viénot/Brettel/Mollon 1999 (protan, deutan) and Brettel tritan approximation, linear sRGB.
"""
import itertools, sys
import numpy as np

def hex2rgb(h): h = h.lstrip("#"); return np.array([int(h[i:i+2], 16) / 255 for i in (0, 2, 4)])
def lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def oklab(l):
    M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
    M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
    return M2 @ np.cbrt(M1 @ l)
CVD = {
    "protan": np.array([[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]),
    "deutan": np.array([[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]),
    "tritan": np.array([[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]),
}
def lum(l): return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
def contrast(a, b): la, lb = sorted([lum(a), lum(b)], reverse=True); return (la + 0.05) / (lb + 0.05)

cols = [c.strip() for c in sys.argv[1].split(",")]
surf = lin(hex2rgb(sys.argv[2]))
L = [lin(hex2rgb(c)) for c in cols]
ok = True
for c, l in zip(cols, L):
    cr = contrast(l, surf); flag = "" if cr >= 3 else "  <3:1 (needs labels)"
    print(f"{c} contrast {cr:4.2f}{flag}")
worst = {}
pairs = list(zip(enumerate(L), list(enumerate(L))[1:])) if "--adjacent" in sys.argv else itertools.combinations(enumerate(L), 2)
for (i, a), (j, b) in pairs:
    for mode in ["normal", *CVD]:
        A, B = (a, b) if mode == "normal" else (np.clip(CVD[mode] @ a, 0, 1), np.clip(CVD[mode] @ b, 0, 1))
        d = 100 * np.linalg.norm(oklab(A) - oklab(B))
        if mode not in worst or d < worst[mode][0]: worst[mode] = (d, cols[i], cols[j])
for mode, (d, a, b) in worst.items():
    lim = 15 if mode == "normal" else 8
    status = "PASS" if d >= lim else ("FLOOR (secondary encoding)" if mode != "normal" and d >= 6 else "FAIL")
    ok &= status != "FAIL"
    print(f"{mode:7s} min ΔE {d:5.1f}  {a} vs {b}  {status}")
print("RESULT", "PASS" if ok else "FAIL")
