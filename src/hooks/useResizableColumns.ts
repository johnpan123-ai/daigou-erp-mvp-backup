import { useState } from 'react';

export function useResizableColumns(storageKey: string, defaultWidths: Record<string, number>) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        return { ...JSON.parse(saved) };
      } catch (e) {
        // ignore
      }
    }
    return {};
  });

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;

    // Get current rendered width from DOM as fallback
    const target = e.target as HTMLElement;
    const th = target.closest('th');
    const renderedWidth = th ? th.offsetWidth : 0;

    const startWidth = colWidths[colKey] || defaultWidths[colKey] || renderedWidth || 150;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const newWidth = Math.max(50, startWidth + dx);
      setColWidths(prev => ({
        ...prev,
        [colKey]: newWidth
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      setColWidths(current => {
        localStorage.setItem(storageKey, JSON.stringify(current));
        return current;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const resetWidths = () => {
    setColWidths({});
    localStorage.removeItem(storageKey);
  };

  return {
    colWidths,
    handleMouseDown,
    resetWidths
  };
}
