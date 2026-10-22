import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Display-only text whose font size is chosen from `sizes` by measuring the real rendered
 * width of its own container (works for mixed CJK / Latin text):
 * - if some size fits on one line, the largest such size is used;
 * - otherwise the largest size not above `multiLineMax` that still reaches the fewest lines
 *   possible at the smallest size is used, and the text wraps naturally.
 * It never truncates and never goes below the smallest size.
 *
 * The size is recomputed only when the text or the available width changes (and once after
 * web fonts finish loading), so expand/collapse, copy and check interactions never change it.
 */
export const AdaptiveFitText = ({
  text,
  sizes,
  lineHeight = 1.3,
  multiLineMax,
  style,
  testId,
}: {
  text: string;
  sizes: readonly number[];
  lineHeight?: number;
  multiLineMax?: number;
  style?: CSSProperties;
  testId?: string;
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const ordered = [...sizes].sort((a, b) => b - a);
  const sizesKey = ordered.join(',');
  const [fontSize, setFontSize] = useState<number>(ordered[ordered.length - 1]);
  const lastWidth = useRef<number>(-1);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const candidates = sizesKey.split(',').map(Number);
    const fit = () => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0) return;
      lastWidth.current = width;
      const previous = element.style.fontSize;
      const linesAt = (size: number) => {
        element.style.fontSize = `${size}px`;
        return Math.max(1, Math.round(element.getBoundingClientRect().height / (size * lineHeight)));
      };
      const smallest = candidates[candidates.length - 1];
      const minimumLines = linesAt(smallest);
      const capped = candidates.filter(size => multiLineMax === undefined || size <= multiLineMax);
      const chosen = minimumLines === 1
        ? candidates.find(size => linesAt(size) === 1) ?? smallest
        : capped.find(size => linesAt(size) <= minimumLines) ?? smallest;
      element.style.fontSize = previous;
      setFontSize(chosen);
    };
    fit();
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth.current) >= 1) fit();
    });
    observer.observe(element);
    let cancelled = false;
    void document.fonts?.ready.then(() => { if (!cancelled) fit(); });
    return () => { cancelled = true; observer.disconnect(); };
  }, [text, sizesKey, lineHeight, multiLineMax]);

  return (
    <span
      ref={ref}
      data-testid={testId}
      data-font-size={fontSize}
      style={{ display: 'block', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', ...style, fontSize: `${fontSize}px`, lineHeight }}
    >
      {text}
    </span>
  );
};
