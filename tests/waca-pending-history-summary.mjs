import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import ts from 'typescript';

// The pending summary itself never triggers a rematch or quantity write.
const file='src/pages/WacaIntegration.tsx';
const before=execFileSync('git',['show',`bf8185c4cadcffbfc6ccc11b0cfd13324df37311:${file}`],{encoding:'utf8'});
const nonJsx=source=>{
  const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const transform=ts.transform(tree,[context=>{
    const visit=node=>ts.isVariableDeclaration(node)&&node.name.getText(tree)==='resolutionText'
      ?ts.factory.updateVariableDeclaration(node,node.name,node.exclamationToken,node.type,ts.factory.createNull())
      :ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node)
      ?ts.factory.createNull():ts.visitEachChild(node,visit,context);
    return node=>ts.visitNode(node,visit);
  }]);
  const result=ts.createPrinter({removeComments:true}).printFile(transform.transformed[0]);transform.dispose();return result;
};
assert.equal(nonJsx(readFileSync(file,'utf8')),nonJsx(before),'Non-JSX runtime must stay identical');
const ssr=await createServer({configFile:false,server:{middlewareMode:true},appType:'custom'});
try {
  const core=await ssr.ssrLoadModule('/src/waca/orderCore.ts');
  const master=await ssr.ssrLoadModule('/src/waca/masterReference.ts');
  const row={orderNumber:'HISTORY',orderStatus:'處理中',purchasedAt:'2026-09-28',productCode:'GP-NEW',
    productTitle:'新商品 2026',spec1:'紅色',spec2:'',specCode:'',quantity:2,subtotal:200};
  const repo=core.createWacaRepository();core.importWacaRows([row],repo,[],'no-master');
  assert.equal([...repo.items.values()][0].productVariantId,null);
  const variants=[{id:'canonical-variant',product_group_id:'canonical-group',myacg_item_code:'G-NEW',
    product_title:row.productTitle,variant_name:row.spec1,raw_variant_name:row.spec1}];
  // BuyAnime creates only its current master. There is NO WACA durable push.
  const currentLinks=master.linksFromMyAcgInventory([{myacg_parent_code:row.productCode,myacg_item_code:'G-NEW',
    product_title:row.productTitle,raw_variant_name:row.spec1}],variants,'current-master','').links;
  const current=master.buildWacaMasterReference(variants,currentLinks);
  assert.equal(core.matchWacaItem(row,core.indexWacaMaster(current)).resolution,'SPEC_NAME_EXACT_UNIQUE');
  core.importWacaRows([],repo,current,'historical-dry-run');
  assert.equal([...repo.items.values()][0].productVariantId,'canonical-variant');
  assert.equal(repo.autoQuantities.get('canonical-variant'),2);
} finally {await ssr.close();}

const origin='http://127.0.0.1:4397';
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--mode','staging','--host','127.0.0.1',
  '--port','4397','--strictPort','--configLoader','runner'],{env:{...process.env,
    VITE_SUPABASE_URL:'https://rhfdjsklfrgpoqsaqpkn.supabase.co',VITE_SUPABASE_ANON_KEY:'isolated-test-not-credential',
    VITE_DEPLOYMENT_ENV:'staging'},stdio:['ignore','pipe','pipe']});
let startup='',browser;vite.stdout.on('data',b=>{startup+=b;});vite.stderr.on('data',b=>{startup+=b;});
const timings=[];
try {
  for(let n=0;n<100;n++){
    try{if((await fetch(origin)).ok)break;}catch{/* local startup */}
    if(n===99||vite.exitCode!==null)throw Error(startup);
    await new Promise(r=>setTimeout(r,200));
  }
  browser=await chromium.launch({executablePath:process.env.CORE_TEST_CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  for(const suffix of ['', '&lastPending=1', '&noBatch=1']){
    const context=await browser.newContext({viewport:{width:1366,height:900}});let external=0;
    await context.route('https://**/*',route=>{external++;return route.abort();});
    const page=await context.newPage();const fatal=[];page.on('pageerror',e=>fatal.push(e.message));
    await page.goto(origin+'/tests/fixtures/waca-cloud-ui-parity.html?pending=1'+suffix);
    await page.waitForFunction(()=>window.wacaUiFixture?.calls().reads>0&&!document.body.textContent.includes('正在讀取 WACA 訂單資料'));
    const calls=await page.evaluate(()=>window.wacaUiFixture.calls());const t=performance.now();
    await page.getByRole('navigation',{name:'WACA 功能'}).getByRole('button',{name:'待處理 127',exact:true}).click();
    const summary=page.getByRole('status',{name:'待處理來源摘要'});await summary.waitFor();timings.push(performance.now()-t);
    const text=await summary.innerText();assert.match(text,/未配對訂單列：84 列（45 種商品特徵）/);
    assert.match(text,/有效數量摘要：43 項/);assert.match(text,/與上述訂單列重疊/);
    assert.match(text,/不是最近匯入新增的錯誤數/);
    if(!suffix){assert.match(text,/已配對：17 列，待配對：0 列/);assert.match(text,/下方保留的是歷史訂單待處理/);}
    if(suffix.includes('lastPending')){assert.match(text,/待配對：1 列/);assert.doesNotMatch(text,/最近檔案沒有未配對商品/);}
    if(suffix.includes('noBatch')){assert.match(text,/無法判定最近檔案的結果/);assert.doesNotMatch(text,/最近檔案沒有未配對商品/);}
    assert.equal(await page.getByText('WACA 商品編號：GP-PENDING-0',{exact:true}).count(),1);
    assert.equal(await page.getByText('SKU：GP-PENDING-0',{exact:true}).count(),0);
    for(const width of [1366,390]){
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'SUMMARY_OVERFLOW');
    }
    await page.getByRole('navigation',{name:'WACA 功能'}).getByRole('button',{name:'WACA 匯入',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.wacaUiFixture.calls()),calls,'Tabs/summary cannot refresh or mutate');
    assert.equal(external,0);assert.deepEqual(fatal,[]);await context.close();
  }
  console.log(JSON.stringify({result:'PASS',historicalItems:84,uniqueFeatures:45,overlappingSummaries:43,tabCount:127,
    latestFilePending:0,missingBatchNotInvented:true,currentFilePendingVisible:true,presentationOnly:true,
    decoupledHistoricalRematch:'PASS',supabaseRequests:0,businessWrites:0,pendingTabMs:timings}));
} finally {await browser?.close();vite.kill();}
