import {
  createCloudClosingDateBatchGateway,
  createNextClosingDateBatchGateway,
} from './closingDateBatchGateway';
import type { ClosingDateBatchGateway } from './closingDateBatchGateway';
import {
  createCloudClosingDateResolutionRepository,
  createNextClosingDateResolutionRepository,
} from './closingDateResolutionSidecarRepository';
import type { ClosingDateResolutionSidecarRepository } from './closingDateResolutionSidecarRepository';
import { transitionResolutionBatch } from './closingDateResolutionDomain';
import type { ResolutionBatch } from './closingDateResolutionDomain';
import {
  assertClosingDateWorkbenchUiAccess,
  getClosingDateWorkbenchMode,
} from './closingDateWorkbenchAccess';

export interface ClosingDateWorkbenchRuntime {
  repository: ClosingDateResolutionSidecarRepository;
  gateway: ClosingDateBatchGateway;
}

let singleton: ClosingDateWorkbenchRuntime | null = null;
let singletonMode: ReturnType<typeof getClosingDateWorkbenchMode> = null;

export function getClosingDateWorkbenchRuntime(): ClosingDateWorkbenchRuntime {
  assertClosingDateWorkbenchUiAccess();
  const mode = getClosingDateWorkbenchMode();
  if (!mode) throw new Error('Closing Date Resolution Workbench runtime mode is unavailable.');
  if (singleton && singletonMode !== mode) {
    singleton.repository.close();
    singleton = null;
  }
  if (!singleton) {
    const repository = mode === 'cloud'
      ? createCloudClosingDateResolutionRepository()
      : createNextClosingDateResolutionRepository();
    singleton = {
      repository,
      gateway: mode === 'cloud'
        ? createCloudClosingDateBatchGateway({ repository })
        : createNextClosingDateBatchGateway({ repository }),
    };
    singletonMode = mode;
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
