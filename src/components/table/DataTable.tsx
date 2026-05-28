import { useViewport } from '../../contexts/ViewportContext';

interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => React.ReactNode;
  width?: string;
  align?: 'left' | 'center' | 'right';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyState?: React.ReactNode;
  renderMobileCard?: (item: T) => React.ReactNode;
}

export function DataTable<T>({ columns, data, keyExtractor, emptyState, renderMobileCard }: DataTableProps<T>) {
  const { isMobile } = useViewport();

  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  // 強制手機版渲染
  if (isMobile && renderMobileCard) {
    return (
      <div className="flex-col gap-md">
        {data.map(item => (
          <div key={keyExtractor(item)}>
            {renderMobileCard(item)}
          </div>
        ))}
      </div>
    );
  }

  // 預設/桌機版渲染
  return (
    <div className="table-wrapper" style={{
      maxHeight: '600px',
      overflowY: 'auto',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-sm)',
      backgroundColor: 'var(--color-bg-surface)'
    }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '13px'
      }}>
        <thead style={{
          position: 'sticky',
          top: 0,
          backgroundColor: 'var(--color-bg-surface-active)',
          zIndex: 1,
          boxShadow: '0 1px 0 var(--color-border)'
        }}>
          <tr>
            {columns.map(col => (
              <th key={col.key} style={{
                padding: '8px 12px',
                textAlign: col.align || 'left',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                width: col.width,
                whiteSpace: 'nowrap'
              }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item, index) => (
            <tr key={keyExtractor(item)} style={{
              backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
              borderBottom: '1px solid var(--color-border)'
            }}
            className="hover:bg-surface-hover transition-colors"
            >
              {columns.map(col => (
                <td key={col.key} style={{
                  padding: '8px 12px',
                  textAlign: col.align || 'left',
                }}>
                  {col.render ? col.render(item) : (item as any)[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
