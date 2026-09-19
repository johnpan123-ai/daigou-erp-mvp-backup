import type { OutboundShipment } from './db';

export const OUTBOUND_STATUS_FILTERS = ['all', 'draft', 'packing', 'shipped', 'received'] as const;
export type OutboundStatusFilter = typeof OUTBOUND_STATUS_FILTERS[number];

export const OUTBOUND_SORT_MODES = ['status-recent', 'date-desc', 'date-asc'] as const;
export type OutboundSortMode = typeof OUTBOUND_SORT_MODES[number];

export const parseOutboundStatusFilter = (value: string | null): OutboundStatusFilter => (
  OUTBOUND_STATUS_FILTERS.includes(value as OutboundStatusFilter) ? value as OutboundStatusFilter : 'all'
);

export const parseOutboundSortMode = (value: string | null): OutboundSortMode => (
  OUTBOUND_SORT_MODES.includes(value as OutboundSortMode) ? value as OutboundSortMode : 'date-desc'
);

const timestamp = (value?: string): number => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

export const getOutboundStatusTransitionTimestamp = (shipment: OutboundShipment): number => (
  timestamp(shipment.status_changed_at)
);

export const sortOutboundShipments = (
  shipments: readonly OutboundShipment[],
  mode: OutboundSortMode,
): OutboundShipment[] => [...shipments].sort((left, right) => {
  const leftCreated = timestamp(left.created_at);
  const rightCreated = timestamp(right.created_at);
  if (mode === 'date-asc') return leftCreated - rightCreated || left.id.localeCompare(right.id);
  if (mode === 'date-desc') return rightCreated - leftCreated || left.id.localeCompare(right.id);

  const leftStatus = getOutboundStatusTransitionTimestamp(left);
  const rightStatus = getOutboundStatusTransitionTimestamp(right);
  const statusDiff = rightStatus - leftStatus;
  if (Number.isFinite(statusDiff) && statusDiff !== 0) return statusDiff;
  if (leftStatus !== rightStatus) return leftStatus === Number.NEGATIVE_INFINITY ? 1 : -1;
  return rightCreated - leftCreated || left.id.localeCompare(right.id);
});
