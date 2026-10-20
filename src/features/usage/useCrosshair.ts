import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';

/**
 * Pointer position over a chart, as a fraction 0..1 of its plot width. The
 * chart turns that into a time and draws its own crosshair and readout.
 */
export function useCrosshair(plotLeft: number, plotWidth: number, viewWidth: number) {
  const [fraction, setFraction] = useState<number | null>(null);
  const onMove = useCallback(
    (event: MouseEvent<SVGElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * viewWidth;
      const f = (x - plotLeft) / plotWidth;
      setFraction(f >= 0 && f <= 1 ? f : null);
    },
    [plotLeft, plotWidth, viewWidth]
  );
  const onLeave = useCallback(() => setFraction(null), []);
  return { fraction, onMove, onLeave };
}
