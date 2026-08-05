import { useEffect, useRef, useState } from 'react';

export function useResizableColumns(
  storageKey: string,
  defaultWidths: Record<string, number>
) {
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
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

  useEffect(() => () => {
    activeDragCleanupRef.current?.();
    activeDragCleanupRef.current = null;
  }, []);

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    activeDragCleanupRef.current?.();

    const startX = e.clientX;

    // Get current rendered width from DOM as fallback
    const target = e.target as HTMLElement;
    const th = target.closest('th');
    const renderedWidth = th ? th.offsetWidth : 0;

    const startWidth = colWidths[colKey] || defaultWidths[colKey] || renderedWidth || 150;
    let currentWidth = startWidth;
    let animationFrameId: number | null = null;

    const applyPendingWidth = () => {
      animationFrameId = null;
      if (th) {
        th.style.width = `${currentWidth}px`;
      }
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      currentWidth = Math.max(50, startWidth + dx);

      if (animationFrameId === null) {
        animationFrameId = window.requestAnimationFrame(applyPendingWidth);
      }
    };

    const cleanupDrag = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', cleanupDrag);

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const handleMouseUp = () => {
      cleanupDrag();
      activeDragCleanupRef.current = null;

      if (th) {
        th.style.width = `${currentWidth}px`;
      }

      // Commit to React state (and persist) exactly once, at the end of the drag.
      setColWidths(prev => {
        const next = { ...prev, [colKey]: currentWidth };
        localStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
    };

    activeDragCleanupRef.current = cleanupDrag;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', cleanupDrag);
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
