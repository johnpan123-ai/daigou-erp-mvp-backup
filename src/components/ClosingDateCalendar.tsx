import { useState } from 'react';

/**
 * Small calendar popover for a YYYY/MM/DD text field. It never takes focus (mouse-down is
 * prevented), so typing, Enter, Esc and Blur on the text field keep working exactly as before;
 * nothing is chosen until a day is clicked (an empty field never becomes "today").
 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n: number) => String(n).padStart(2, '0');

const parseSlashDate = (value: string): { y: number; m: number; d: number } | null => {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? { y, m, d } : null;
};

export function ClosingDateCalendar({ value, onPick, onClose }: {
  value: string;
  onPick: (slashDate: string) => void;
  onClose: () => void;
}) {
  const selected = parseSlashDate(value);
  const today = new Date();
  const [view, setView] = useState(() => ({ y: selected?.y ?? today.getFullYear(), m: selected?.m ?? today.getMonth() + 1 }));
  const first = new Date(view.y, view.m - 1, 1).getDay();
  const days = new Date(view.y, view.m, 0).getDate();
  const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const shift = (delta: number) => setView(v => {
    const index = v.y * 12 + (v.m - 1) + delta;
    return { y: Math.floor(index / 12), m: (index % 12) + 1 };
  });
  const navButton = { border: '1px solid #e2e8f0', background: '#fff', borderRadius: 6, width: 32, height: 32, cursor: 'pointer', fontSize: 14 } as const;
  return (
    <div
      data-testid="closing-date-calendar"
      role="dialog"
      aria-label="選擇官方結單日"
      onMouseDown={event => event.preventDefault()}
      // Rendered inside the field's <label>: stop the click from re-activating (re-opening) the field.
      onClick={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
      style={{
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 1000, width: 252, maxWidth: 'calc(100vw - 24px)',
        background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 10px 24px rgba(15,23,42,0.16)',
        padding: 8, fontSize: 13, color: '#0f172a', fontWeight: 400,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <button type="button" tabIndex={-1} aria-label="上個月" style={navButton} onClick={() => shift(-1)}>‹</button>
        <span data-testid="closing-date-calendar-month" style={{ fontWeight: 700 }}>{view.y}/{pad(view.m)}</span>
        <button type="button" tabIndex={-1} aria-label="下個月" style={navButton} onClick={() => shift(1)}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {WEEKDAYS.map(day => <span key={day} style={{ color: '#94a3b8', fontSize: 11, padding: '2px 0' }}>{day}</span>)}
        {cells.map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const isSelected = selected?.y === view.y && selected.m === view.m && selected.d === day;
          const isToday = today.getFullYear() === view.y && today.getMonth() + 1 === view.m && today.getDate() === day;
          return (
            <button
              key={day}
              type="button"
              tabIndex={-1}
              data-date={`${view.y}/${pad(view.m)}/${pad(day)}`}
              aria-pressed={isSelected}
              onClick={() => onPick(`${view.y}/${pad(view.m)}/${pad(day)}`)}
              style={{
                height: 32, borderRadius: 6, cursor: 'pointer', fontSize: 13,
                border: isToday && !isSelected ? '1px solid #93c5fd' : '1px solid transparent',
                background: isSelected ? '#2563eb' : 'transparent', color: isSelected ? '#fff' : '#0f172a',
              }}
            >{day}</button>
          );
        })}
      </div>
    </div>
  );
}
