import type { VariantConflictApproval } from './restoreVariantNormalization';

// Owner-approved duplicate Variant conflicts (2026-10-15 22:40 +08, "全部採用 ERP1 原本畫面顯示的數值").
// Each approval is bound to the EXACT state of its duplicate set (IDs, identity fields, manual
// quantities, deletion state) in ERP1 backup cloud-erp-snapshot-2026-10-15-130320.json
// (sha256 7d1c61245c09ee9e5cc96f022717afa7b98530285d67ba0cc635b464d1aa47ae). If a future backup
// holds a different state for a set, its approval does not apply and the Restore stops.
// Adding an approval requires a new reviewed release; approvals are never inferred.
export const OWNER_APPROVED_VARIANT_CONFLICTS: readonly VariantConflictApproval[] = Object.freeze([
  // G07211541 【小河馬日本代購】預購 27年01月 代理版 GSC Hololive 議會組  | waca_manual_adjustment = 6 (merged-away 9e96f732-b12e-4be4-bef2-3dc90dc42e22 = [4])
  { setStateFingerprint: '3d9d1e161c9d20b4cd68043c4fd50aafe7bd1afef6bf407733d4c42071f4e1e7', field: 'waca_manual_adjustment', approvedValue: 6,
    keepVariantId: '10792c6d-3fd1-438d-ac9a-8939ae5539b5', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07220797 【小河馬日本代購】預購 27年01月 代理版 GSC 換裝玩偶 娃娃 BanG  | waca_manual_adjustment = 24 (merged-away edf8b16e-fbb4-4e27-950c-da0122a5593a = [6])
  { setStateFingerprint: 'd66204a8267cc5fea593a07f6390b1b7c79484043049c42d88651b48c422cf74', field: 'waca_manual_adjustment', approvedValue: 24,
    keepVariantId: '72b6edc0-fada-413e-8e2a-8e5caa697d06', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07220798 【小河馬日本代購】預購 27年01月 代理版 GSC 換裝玩偶 娃娃 BanG  | waca_manual_adjustment = 8 (merged-away dfa887bf-fc56-4ef0-9b8c-db63b2e7d0b6 = [2])
  { setStateFingerprint: 'eb5a4cf9e204e499250f8c5b3dce4bbfb93afe8d17b391fae302ad5a50a600c4', field: 'waca_manual_adjustment', approvedValue: 8,
    keepVariantId: 'eb450f1a-ceb2-4a9c-a650-f1d6e137ae16', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07220801 【小河馬日本代購】預購 27年01月 代理版 GSC 換裝玩偶 娃娃 BanG  | waca_manual_adjustment = 16 (merged-away cb26c170-0c2d-49de-b89a-6906061a147a = [4])
  { setStateFingerprint: 'f44e16e896092f416771e7a7ca6af4c62531c49237232bc1d1e276af8b0cc070', field: 'waca_manual_adjustment', approvedValue: 16,
    keepVariantId: '5c26b154-a486-4c48-b9a5-5fb0f2a4b5a4', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07223023 【小河馬日本代購】預購 26年11月 代理版 GSC Hololive Engl | waca_manual_adjustment = 8 (merged-away ca43e56f-55f5-4d9a-8ea5-24adc6d71216 = [6])
  { setStateFingerprint: '888ae9aa53175b989e0c519dee57f9b6f14cab97c085ee2fe9deca68bc6c9b59', field: 'waca_manual_adjustment', approvedValue: 8,
    keepVariantId: 'faaaf39c-47b3-48f6-81f1-6ac50c188c38', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07233807 【小河馬日本代購】預購 26年09月 Hololive 星街すいせい 星街彗星  | myacg_manual_adjustment = -12 (merged-away e9c09259-b4b2-46d7-960d-f95d483ce2c5 = [-3])
  { setStateFingerprint: 'd796dd0d40bbf27564c2e4c53a9d398d18396f5a39dba9957d0f2db1b5ec010a', field: 'myacg_manual_adjustment', approvedValue: -12,
    keepVariantId: 'aed068f5-c369-4a94-be41-2b8488a813de', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07234959 【小河馬日本代購】預購 27年09月 代理版 GSC hololive 櫻巫女  | waca_manual_adjustment = 4 (merged-away dc2df931-1a58-4397-a82d-0fe783ec2499 = [5])
  { setStateFingerprint: '9d6c11bbd3da25da76aaa8895d6b6b4d908a958be55a054d1a614216f7acd630', field: 'waca_manual_adjustment', approvedValue: 4,
    keepVariantId: 'b06dcfcf-7629-4d65-af73-69286f7cc0ea', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07240963 【小河馬日本代購】預購 26年12月 Hololive English セシリア | waca_manual_adjustment = 4 (merged-away d2e02d1f-8011-4c5e-ab3f-6bf14005b571 = [1])
  { setStateFingerprint: 'ac69f591f641c204f687bad1ce93e3aa5db8c0ccfc73a46ee772633134a55e93', field: 'waca_manual_adjustment', approvedValue: 4,
    keepVariantId: '2c380694-daf6-4579-83ce-938b3561f89e', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07246755 【小河馬日本代購】預購 26年12月 代理版 ROBOT魂 MSZ-006 Z鋼 | purchased_manual_adjustment = 3 (merged-away e37322da-9a3d-466a-8121-89d2047637a5 = [2])
  { setStateFingerprint: '6e060476f6f944086b6503c41f8adee0d5ebcd5c76c30a9083ae6a2c651e9f39', field: 'purchased_manual_adjustment', approvedValue: 3,
    keepVariantId: '32a48598-a18d-4d15-ae6d-36ad71fdf049', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
  // G07247850 【小河馬日本代購】預購 27年05月 再版 代理 萬代 盒玩 SMP 百獸戰隊  | purchased_manual_adjustment = 4 (merged-away c0a24c9b-f96b-499f-b8cc-6692d8082edb = [3])
  { setStateFingerprint: 'f7e086dae2981f4573258a202fe8a053b18c3bc0c4f2553678c8d7598a7776bf', field: 'purchased_manual_adjustment', approvedValue: 4,
    keepVariantId: '66f7c079-56bc-4f52-b46b-c593a8a4ca45', approvedBy: 'Owner', approvedAt: '2026-10-15T14:40:00Z' },
]);
