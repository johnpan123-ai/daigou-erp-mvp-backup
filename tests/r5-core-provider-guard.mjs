import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {restoreReviewedR5CoreProvider} from '../scripts/r5-core-provider-review.mjs';
import {assertReviewedProviderContract} from '../scripts/post-adoption-descendant.mjs';
const data='src/providers/dataProvider.ts', cloud='src/providers/cloud/supabaseProvider.ts';
const read=f=>readFileSync(f,'utf8').replace(/\r\n?/g,'\n');
const base=f=>execFileSync('git',['show','23a02377044c7cf56a41aabe1ddce79fc0535df5:'+f],{encoding:'utf8'}).replace(/\r\n?/g,'\n');
const adopted=f=>execFileSync('git',['show','5f73b2b02d9008dc863cf92978e6ea8e40a850ec:'+f],{encoding:'utf8'}).replace(/\r\n?/g,'\n');
for(const file of [data,cloud]){
  assertReviewedProviderContract(file,adopted(file),read(file));
  // The exact overlay reverses only this task's additions, not any old control.
  const restored=restoreReviewedR5CoreProvider(file,read(file));
  const ts=await import('typescript');const p=ts.default.createPrinter({removeComments:true});
  const canonical=s=>p.printFile(ts.default.createSourceFile(file,s,ts.default.ScriptTarget.Latest,true));
  assert.equal(canonical(restored),canonical(base(file)));
}
const reject=(f,from,to)=>{
  const s=read(f);assert.ok(s.includes(from));
  assert.throws(()=>assertReviewedProviderContract(f,adopted(f),s.replace(from,to)),/FAILED_CLOSED/);
};
reject(data,'    this.assertMode();','    void 0;');
reject(data,'assertProviderBinding(this.binding);',"localStorage.setItem('leak','1');");
reject(data,'    this.binding ??= bindProviderMode();','    this.binding = bindProviderMode();');
reject(data,'      this.assertMode();\n      this.registerWrite();','      this.registerWrite();');
reject(cloud,"startsWith('CORE_')","startsWith('')");
reject(cloud,'throw new SaveabilityError(cloudMutationFailureMessage(error));','return { ok: true };');
reject(cloud,'async canWriteCloud(): Promise<boolean> {','async canWriteCloud(): Promise<boolean> { return true;');
console.log('PASS R5 exact overlay restores both providers to immutable v32 AST; seven bypass/regression mutations rejected; legacy guard pins unchanged');
