

interface KpiCardProps {
  title: string;
  value: string | number;
  variant?: 'default' | 'danger' | 'warning' | 'success' | 'info';
  subtitle?: string;
}

export function KpiCard({ title, value, variant = 'default', subtitle }: KpiCardProps) {
  let valueColor = 'var(--color-text-primary)';
  if (variant === 'danger') valueColor = 'var(--color-danger)';
  if (variant === 'warning') valueColor = 'var(--color-warning)';
  if (variant === 'success') valueColor = 'var(--color-success)';
  if (variant === 'info') valueColor = 'var(--color-info)';

  return (
    <div className="card flex-col gap-xs" style={{ flex: 1 }}>
      <span className="text-secondary text-sm font-medium">{title}</span>
      <div style={{ fontSize: '24px', fontWeight: 600, color: valueColor }}>
        {value}
      </div>
      {subtitle && <span className="text-muted text-xs">{subtitle}</span>}
    </div>
  );
}

interface ProgressBarProps {
  total: number;
  current: number;
  label?: string;
}

export function ProgressBar({ total, current, label }: ProgressBarProps) {
  const percentage = total === 0 ? 0 : Math.min(100, Math.round((current / total) * 100));
  
  let barColor = 'var(--color-success)';
  if (percentage < 50) barColor = 'var(--color-danger)';
  else if (percentage < 80) barColor = 'var(--color-warning)';

  return (
    <div className="flex-col gap-xs">
      <div className="flex justify-between items-center text-sm">
        <span className="text-secondary">{label || '完成率'}</span>
        <span className="font-medium">{percentage}%</span>
      </div>
      <div style={{
        height: '6px',
        backgroundColor: 'var(--color-bg-surface-active)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden'
      }}>
        <div style={{
          height: '100%',
          width: `${percentage}%`,
          backgroundColor: barColor,
          transition: 'width 0.3s ease, background-color 0.3s ease'
        }} />
      </div>
      <div className="flex justify-between items-center text-xs text-muted">
        <span>已採購: {current}</span>
        <span>總需求: {total}</span>
      </div>
    </div>
  );
}
