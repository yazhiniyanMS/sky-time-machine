"use client";

/** EPSF kernel on the comparison grid, sqrt stretch, north up. */
export function PsfKernel({ k, label }: { k: number[][]; label: string }) {
  const n = k.length;
  const max = Math.max(...k.flat());
  const c = 6;
  return (
    <figure className="flex flex-col items-center gap-1">
      <svg width={n * c} height={n * c} role="img" aria-label={label}>
        {k.map((row, j) =>
          row.map((v, i) => {
            const g = Math.round(255 * Math.sqrt(Math.max(0, v) / max));
            // row 0 is the bottom of the grid (north up)
            return <rect key={`${i}-${j}`} x={i * c} y={(n - 1 - j) * c} width={c} height={c} fill={`rgb(${g},${g},${g})`} />;
          }),
        )}
      </svg>
      <figcaption className="text-[10px] text-faint">{label}</figcaption>
    </figure>
  );
}
