import { cloudMutationFailureMessage, SaveabilityError } from '../providers/cloud/cloudFieldCas';

/** The Provider already converts the server error to a fixed SaveabilityError.
 * Translate only its bounded capacity message, and only at the cancellation UI.
 * Never turn an unknown/transport/CAS failure into a known rollback message.
 */
export function receivingCancellationMessage(error: unknown, batch: boolean): string {
  const message = cloudMutationFailureMessage(error);
  if (!(error instanceof SaveabilityError)) return message;
  const match = /^來源配置數量超過可用數量（已配置 (\d+) 件），操作未完成。$/.exec(message)
    ?? /^此來源已配置 (\d+) 件，未配置 \d+ 件；不可整列取消點收。部分取消需另案設計。$/.exec(message);
  const allocated = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(allocated) || allocated <= 0) return message;
  return batch
    ? '本次操作包含已配置出庫的商品，因此無法全部取消點收。所有商品均維持原狀。'
    : `此商品已有 ${allocated} 件配置至出庫單，因此無法取消整筆點收。請先解除相關出庫配置。`;
}
