import type { ProductGroup } from './db';
import type {
  ResolutionApplySelection,
  ResolutionBatch,
} from './closingDateResolutionDomain';
import { planAtomicClosingDateApply } from './closingDateResolutionDomain';
import { dataProvider } from '../providers/dataProvider';

export type CloudClosingDateApplyResult =
  | { status: 'APPLIED'; appliedCount: number }
  | { status: 'CONFLICT'; codes: string[] };

export interface CloudClosingDateApplyDependencies {
  readGroups?: () => Promise<ProductGroup[]>;
  saveGroups?: (groups: ProductGroup[]) => Promise<void>;
}

const storedClosingDate = (value: string): string => value.replace(/-/g, '/');

export async function applyCloudClosingDateResolutionBatch(
  resolutionBatch: ResolutionBatch,
  selections: readonly ResolutionApplySelection[],
  dependencies: CloudClosingDateApplyDependencies = {},
): Promise<CloudClosingDateApplyResult> {
  if (resolutionBatch.status !== 'COMPLETED') {
    throw new Error(`Only a completed resolution batch can be applied: ${resolutionBatch.status}`);
  }
  if (selections.length === 0) throw new Error('No closing-date resolution was selected');
  if (new Set(selections.map(selection => selection.result.erpProductGroupId)).size !== selections.length) {
    throw new Error('Apply request contains duplicate ProductGroup IDs');
  }
  for (const selection of selections) {
    if (
      selection.result.batchId !== resolutionBatch.id
      || selection.result.snapshotVersion !== resolutionBatch.snapshotVersion
      || selection.result.ruleVersion !== resolutionBatch.ruleVersion
    ) {
      throw new Error(`Resolution result does not belong to the selected batch: ${selection.result.id}`);
    }
  }

  const readGroups = dependencies.readGroups ?? (() => dataProvider.getProductGroups());
  const saveGroups = dependencies.saveGroups ?? (groups => dataProvider.saveProductGroups(groups));
  const authoritativeGroups = await readGroups();
  const plan = planAtomicClosingDateApply({
    resolutionBatchId: resolutionBatch.id,
    selections,
    currentProducts: authoritativeGroups.map(group => ({
      erpProductGroupId: group.id,
      updatedAt: group.updated_at ?? null,
      closingDate: group.closing_date ?? null,
    })),
  });
  if (plan.status === 'CONFLICT') {
    return {
      status: 'CONFLICT',
      codes: [...new Set(plan.conflicts.map(conflict => conflict.code))],
    };
  }

  const intents = new Map(plan.writeIntents.map(intent => [intent.erpProductGroupId, intent]));
  const nextGroups = authoritativeGroups.map(group => {
    const intent = intents.get(group.id);
    return intent
      ? { ...group, closing_date: storedClosingDate(intent.afterClosingDate) }
      : group;
  });
  await saveGroups(nextGroups);
  return { status: 'APPLIED', appliedCount: plan.writeIntents.length };
}
