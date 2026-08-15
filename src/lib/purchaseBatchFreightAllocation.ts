export interface PurchaseBatchFreightLine {
  key: string;
  quantity: number;
  unitCost: number;
}

export interface PurchaseBatchFreightAllocation {
  key: string;
  proportionalFreight: number;
  appliedFreight: number;
  newUnitCost: number;
}

export interface PurchaseBatchFreightResult {
  allocations: PurchaseBatchFreightAllocation[];
  eligibleSubtotal: number;
  requestedFreightTotal: number;
  appliedFreightTotal: number;
}

/**
 * Purchase costs are stored as whole Japanese yen. Freight shares keep their
 * full precision until the final per-unit cost is rounded.
 */
export function roundJpyUnitCost(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('實支單價必須是有效的非負數字。');
  }
  return Math.round(value);
}

export function allocatePurchaseBatchFreight(
  freightYen: number,
  lines: PurchaseBatchFreightLine[]
): PurchaseBatchFreightResult {
  if (!Number.isSafeInteger(freightYen) || freightYen <= 0) {
    throw new Error('本批運費必須是大於 0 的整數日圓。');
  }

  const eligible = lines
    .map(line => ({ ...line, amount: line.quantity * line.unitCost }))
    .filter(line => (
      Number.isSafeInteger(line.quantity)
      && line.quantity > 0
      && Number.isFinite(line.unitCost)
      && line.unitCost > 0
      && Number.isFinite(line.amount)
      && line.amount > 0
    ));

  if (eligible.length === 0) {
    throw new Error('目前沒有可分攤運費的採購品項。');
  }

  const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.amount, 0);
  if (!Number.isFinite(eligibleSubtotal) || eligibleSubtotal <= 0) {
    throw new Error('有效商品總額必須大於 0。');
  }

  const allocations = eligible.map(line => {
    const proportionalFreight = freightYen * line.amount / eligibleSubtotal;
    const newUnitCost = roundJpyUnitCost(line.unitCost + proportionalFreight / line.quantity);
    return {
      key: line.key,
      proportionalFreight,
      appliedFreight: (newUnitCost - line.unitCost) * line.quantity,
      newUnitCost
    };
  });

  const appliedFreightTotal = allocations.reduce((sum, line) => sum + line.appliedFreight, 0);

  return {
    allocations,
    eligibleSubtotal,
    requestedFreightTotal: freightYen,
    appliedFreightTotal
  };
}
