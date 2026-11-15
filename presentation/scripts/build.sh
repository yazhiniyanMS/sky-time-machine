#!/bin/sh
# Rebuild the deck end to end (macOS). Run from the repository root with the backend venv present.
set -e
PYTHONPATH=backend .venv/bin/python presentation/scripts/m31_psf_validation.py
.venv/bin/python presentation/scripts/make_figures.py
cd presentation
node scripts/build_deck.js
zip -dq Sky-Time-Machine-Project-Demo.pptx '*/' || true
osascript scripts/export_pdf.applescript "$PWD/Sky-Time-Machine-Project-Demo.pptx" "$PWD/Sky-Time-Machine-Project-Demo.pdf"
