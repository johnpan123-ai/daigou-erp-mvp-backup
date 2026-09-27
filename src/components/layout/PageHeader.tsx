import type { CSSProperties, HTMLAttributes } from 'react';
import { useViewport } from '../../contexts/ViewportContext';

type WorkspaceProps = HTMLAttributes<HTMLDivElement> & { mobileStyle?: CSSProperties };

/** Desktop-only opt-in. Mobile receives the page's pre-task container style. */
export function PageShell({ className = '', mobileStyle, style, children, ...props }: WorkspaceProps) {
  const { isMobile } = useViewport();
  return <div {...props} className={`${isMobile ? '' : 'workspace-page'} ${className}`} style={isMobile ? mobileStyle : style}>
    {children}
  </div>;
}

/** Shared workspace heading; actions remain owned by their page. */
export function PageHeader({ className = '', mobileStyle, style, children, ...props }: HTMLAttributes<HTMLElement> & { mobileStyle?: CSSProperties }) {
  const { isMobile } = useViewport();
  return <header {...props} style={isMobile ? mobileStyle : style} className={`${isMobile ? '' : 'workspace-header'} ${className}`} data-workspace-header>
    {children}
  </header>;
}
