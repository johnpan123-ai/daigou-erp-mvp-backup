import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex-col items-center justify-center gap-md" style={{
      padding: 'var(--spacing-xl)',
      minHeight: '300px',
      border: '1px dashed var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      backgroundColor: 'rgba(255, 255, 255, 0.02)'
    }}>
      <div style={{
        padding: 'var(--spacing-md)',
        backgroundColor: 'var(--color-bg-surface)',
        borderRadius: 'var(--radius-full)',
        color: 'var(--color-text-muted)',
        marginBottom: 'var(--spacing-sm)'
      }}>
        <Icon size={32} />
      </div>
      <h3 style={{ margin: 0 }}>{title}</h3>
      <p className="text-secondary" style={{ textAlign: 'center', maxWidth: '400px', margin: 0 }}>
        {description}
      </p>
      {actionLabel && onAction && (
        <button className="btn btn-primary" onClick={onAction} style={{ marginTop: 'var(--spacing-md)' }}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
