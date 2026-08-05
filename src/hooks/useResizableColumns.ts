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
    let latestOffset = 0;

    const scrollContainer = th?.closest('.mobile-scroll-wrapper') as HTMLElement | null;
    const containerRect = scrollContainer?.getBoundingClientRect();
    const guideLine = document.createElement('div');
    Object.assign(guideLine.style, {
      position: 'fixed',
      top: `${containerRect?.top ?? 0}px`,
      left: `${startX}px`,
      width: '2px',
      height: `${containerRect?.height ?? window.innerHeight}px`,
      backgroundColor: '#2563eb',
      boxShadow: '0 0 0 1px rgba(37, 99, 235, 0.15)',
      pointerEvents: 'none',
      zIndex: '10000',
      transform: 'translate3d(0, 0, 0)'
    });
    document.body.appendChild(guideLine);

    const applyPendingGuidePosition = () => {
      animationFrameId = null;
      guideLine.style.transform = `translate3d(${latestOffset}px, 0, 0)`;
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      latestOffset = dx;
      currentWidth = Math.max(50, startWidth + dx);

      if (animationFrameId === null) {
        animationFrameId = window.requestAnimationFrame(applyPendingGuidePosition);
      }
    };

    const cleanupDrag = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.documentElement.removeEventListener('mouseleave', handleDragCancel);
      window.removeEventListener('blur', handleDragCancel);

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      guideLine.remove();
    };

    const handleDragCancel = () => {
      cleanupDrag();
      activeDragCleanupRef.current = null;
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      currentWidth = Math.max(50, startWidth + (upEvent.clientX - startX));
      cleanupDrag();
      activeDragCleanupRef.current = null;

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
    document.documentElement.addEventListener('mouseleave', handleDragCancel);
    window.addEventListener('blur', handleDragCancel);
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
