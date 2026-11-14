// jsdom lacks canvas, ImageData and ResizeObserver; provide inert stand-ins.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = RO;
if (!(globalThis as any).ImageData) {
  (globalThis as any).ImageData = class {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
  };
}
const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
(HTMLCanvasElement.prototype as any).getContext = () => ctx;

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());
