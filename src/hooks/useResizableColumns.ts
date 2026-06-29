import { useState } from 'react';

export function useResizableColumns(
  storageKey: string,
  defaultWidths: Record<string, number>,
  columnOrder: string[]
) {
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

    // Find the adjacent column in columnOrder
    const colIndex = columnOrder.indexOf(colKey);
    const nextColKey = colIndex !== -1 && colIndex < columnOrder.length - 1 ? columnOrder[colIndex + 1] : null;

    // Find next th to get its rendered width if not set
    let nextRenderedWidth = 0;
    if (nextColKey && th && th.nextElementSibling) {
      nextRenderedWidth = (th.nextElementSibling as HTMLElement).offsetWidth;
    }

    const startNextWidth = nextColKey
      ? (colWidths[nextColKey] || defaultWidths[nextColKey] || nextRenderedWidth || 100)
      : 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      let newWidth = Math.max(50, startWidth + dx);

      if (nextColKey) {
        const actualDx = newWidth - startWidth;
        const newNextWidth = Math.max(50, startNextWidth - actualDx);
        const finalActualDx = startNextWidth - newNextWidth;
        newWidth = startWidth + finalActualDx;

        setColWidths(prev => ({
          ...prev,
          [colKey]: newWidth,
          [nextColKey]: newNextWidth
        }));
      } else {
        setColWidths(prev => ({
          ...prev,
          [colKey]: newWidth
        }));
      }
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
