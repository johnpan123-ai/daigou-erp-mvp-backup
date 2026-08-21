import {
  createNextClosingDateBatchGateway,
} from './closingDateBatchGateway';
import type { ClosingDateBatchGateway } from './closingDateBatchGateway';
import {
  createNextClosingDateResolutionRepository,
} from './closingDateResolutionSidecarRepository';
import type { ClosingDateResolutionSidecarRepository } from './closingDateResolutionSidecarRepository';
import { transitionResolutionBatch } from './closingDateResolutionDomain';
import type { ResolutionBatch } from './closingDateResolutionDomain';
import { assertClosingDateWorkbenchUiAccess } from './closingDateWorkbenchAccess';

export interface ClosingDateWorkbenchRuntime {
  repository: ClosingDateResolutionSidecarRepository;
  gateway: ClosingDateBatchGateway;
}

let singleton: ClosingDateWorkbenchRuntime | null = null;

export function getClosingDateWorkbenchRuntime(): ClosingDateWorkbenchRuntime {
  assertClosingDateWorkbenchUiAccess();
  if (!singleton) {
    const repository = createNextClosingDateResolutionRepository();
    singleton = {
      repository,
      gateway: createNextClosingDateBatchGateway({ repository }),
    };
  }
  return singleton;
}

const isPersistedActiveStatus = (status: ResolutionBatch['status']): boolean => (
  status === 'QUEUED' || status === 'RUNNING' || status === 'CANCELLING'
);

/**
 * A Vite page reload destroys the in-memory runner but leaves its durable
 * status behind. Reconciliation happens only when the Workbench is opened.
 */
export async function reconcileInterruptedClosingDateJobs(
  runtime: ClosingDateWorkbenchRuntime,
  at = new Date().toISOString(),
): Promise<readonly ResolutionBatch[]> {
  const batches = await runtime.repository.listResolutionBatches(50);
  const reconciled: ResolutionBatch[] = [];
  for (const batch of batches) {
    if (!isPersistedActiveStatus(batch.status) || runtime.gateway.hasInMemoryRunner(batch.id)) {
      reconciled.push(batch);
      continue;
    }
    const failed = {
      ...transitionResolutionBatch(batch, 'FAILED', at),
      failure: {
        code: 'RUNNER_INTERRUPTED',
        message: '頁面重新載入後，原本的分析執行器已不存在；可重新分析此批商品。',
        retryable: true,
      },
    } satisfies ResolutionBatch;
    await runtime.repository.updateResolutionJob(failed);
    reconciled.push(failed);
  }
  return reconciled.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
