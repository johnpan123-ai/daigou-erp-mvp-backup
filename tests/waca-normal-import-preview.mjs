// Owner-only local review of the real React page. Fake transport, preview-only commit refusal.
// No real token, cloud connection, business write, migration, push or deployment.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { incidentRows } from './fixtures/waca-preview-incident.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'erp2-waca-owner-review-'));
const file = join(output, 'WACA-正常累加-隔離範例.xlsx');
const headers = ['訂單狀態', '訂單編號', '購買日期', '商品編號', '品名', '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計'];
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers.map(() => '訂單資訊'), headers, ...incidentRows]), 'orders');
XLSX.writeFile(book, file);
const port = '4740';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'staging', '--host', '127.0.0.1', '--port', port,
  '--strictPort', '--configLoader', 'runner'], { cwd: root, env: { ...process.env,
  VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co', VITE_SUPABASE_ANON_KEY: 'isolated-test-key-not-a-real-credential',
  VITE_DEPLOYMENT_ENV: 'staging' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; });
process.once('SIGINT', () => server.kill()); process.once('SIGTERM', () => server.kill());
server.once('exit', code => { if (code) console.error(log); process.exitCode = code ?? 0; });
for (let n = 0; n < 80; n++) {
  if (server.exitCode !== null) throw new Error('LOCAL_REVIEW_SERVER_FAILED');
  if (log.includes('Local:')) break;
  await new Promise(r => setTimeout(r, 250));
  if (n === 79) { server.kill(); throw new Error('LOCAL_REVIEW_SERVER_NOT_READY'); }
}
console.log('本機真實 React 預覽：使用隔離假資料，確認提交會被拒絕。');
console.log(`網址：http://127.0.0.1:${port}/tests/fixtures/waca-ui-review.html?populated=1&incident=1&previewOnly=1`);
console.log(`選擇範例 Excel：${file}`);
console.log('預期：7 個變化規格、+8 件、0 個不必要待核對；關閉第一項篩選可看全部 34 個規格。');
console.log('歷史／取消風險畫面：同一網址改為 ?populated=1&daily=1&previewOnly=1，使用 tests/waca-ui-review.mjs 的隔離範例。');
console.log('只開上面的本機 fixture 網址，不開 /waca 真實連線入口。Ctrl+C 關閉預覽。');
