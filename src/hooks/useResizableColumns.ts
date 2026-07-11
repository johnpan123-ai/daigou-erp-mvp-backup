import { useState } from 'react';

export function useResizableColumns(
  storageKey: string,
  defaultWidths: Record<string, number>
) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        return { ...defaultWidths, ...JSON.parse(saved) };
      } catch (e) {
        // ignore
      }
    }
    return { ...defaultWidths };
  });

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;

    // Get current rendered width from DOM as fallback
    const target = e.target as HTMLElement;
    const th = target.closest('th');
    const renderedWidth = th ? th.offsetWidth : 0;

    const startWidth = colWidths[colKey] || defaultWidths[colKey] || renderedWidth || 150;
    let currentWidth = startWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      currentWidth = Math.max(50, startWidth + dx);

      // Visual-only update while dragging: mutate the header cell's DOM width directly
      // instead of calling setColWidths on every mousemove. Going through React state here
      // used to trigger a full re-render (and all the per-row recomputation that comes with
      // it) dozens of times per second during a drag. With table-layout: fixed, resizing the
      // header <th> alone resizes the whole column for every row, so this is visually
      // identical without the render cost.
      if (th) {
        th.style.width = `${currentWidth}px`;
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      // Commit to React state (and persist) exactly once, at the end of the drag.
      setColWidths(prev => {
        const next = { ...prev, [colKey]: currentWidth };
        localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const resetWidths = () => {
    setColWidths({ ...defaultWidths });
    localStorage.removeItem(storageKey);
  };

  return {
    colWidths,
    handleMouseDown,
    resetWidths
  };
}
