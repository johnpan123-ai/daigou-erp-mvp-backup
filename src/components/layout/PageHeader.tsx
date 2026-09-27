import type { HTMLAttributes } from 'react';

/** Shared workspace heading; actions remain owned by their page. */
export function PageHeader({ className = '', children, ...props }: HTMLAttributes<HTMLElement>) {
  return <header {...props} className={`workspace-header ${className}`} data-workspace-header>
    {children}
  </header>;
}
