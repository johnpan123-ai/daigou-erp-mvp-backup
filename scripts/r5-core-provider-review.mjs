// Additive exact review for the R5 core fix. Existing Provider/Context pins and
// negative checks remain unchanged. Strip ONLY independently reviewed members,
// then send the restored source through every pre-existing guard.
import ts from 'typescript';
import { createHash } from 'node:crypto';
const printer=ts.createPrinter({removeComments:true});
const pins={
  binding:'ccfff3b4a5925b54c13fd3bd2cf9a831fd3104cbb02393a2d8b6e8af262492d2',
  assertMode:'bdbcfbe18e83b2ef764b08ce1585f4cc062e5d85535cfb38e07e996f43c2c1c8',
  guardedWrite:'cd91dc4d150dd6753325b68d761bc2fd5aaf2ad740c6096749fd8fdc4c096e23',
  committedRestoreWrite:'65f88fcb603ea7af7913871b56a52d9e5b1a667a4812623b85219bea967e9f9a',
  getActiveProvider:'776c1e163612fe0b684871309d96f824498ab43132b9c356f6cb760ea06457a8',
  applyJapanPackageTransaction:'09e4ac51acfb24cb97215df8be79ea097ace731c262538116df390a5b8fe56d0',
};
const coreError=`      if (typeof (error as { message?: unknown }).message === 'string'
        && String((error as { message: string }).message).startsWith('CORE_')) {
        throw new SaveabilityError(cloudMutationFailureMessage(error));
      }
`;
const modeImport="import { getProviderMode, bindProviderMode, assertProviderBinding, type ProviderBinding } from './providerMode';";
const fail=()=>{throw Error('DEPLOYMENT_GUARD_FAILED_CLOSED: unreviewed provider member changed (R5 core exact review)');};
export function restoreReviewedR5CoreProvider(file,source) {
  if(source===null)return source;
  const data=file==='src/providers/dataProvider.ts';
  const cloud=file==='src/providers/cloud/supabaseProvider.ts';
  if(!data&&!cloud)return source;
  const normalized=source.replace(/\r\n?/g,'\n');
  if(data&&!/bindProviderMode|assertProviderBinding|this\.assertMode/.test(normalized))return source;
  if(cloud&&!normalized.includes("startsWith('CORE_')"))return source;
  const tree=ts.createSourceFile(file,normalized,ts.ScriptTarget.Latest,true);
  if(tree.parseDiagnostics.length)fail();
  const name=data?'DynamicDataProvider':'SupabaseProvider';
  const cls=tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===name);
  if(!cls)fail();
  const members=data?['binding','assertMode','guardedWrite','committedRestoreWrite','getActiveProvider']:['applyJapanPackageTransaction'];
  const ranges=[];
  for(const key of members){
    const matches=cls.members.filter(n=>n.name?.getText(tree)===key);
    if(matches.length!==1)fail();
    const node=matches[0];
    const digest=createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified,node,tree)).digest('hex');
    if(digest!==pins[key])fail();
    const text=node.getText(tree);
    let restored;
    if(key==='binding'||key==='assertMode')restored='';
    else if(data)restored=text.replace(/^\s*this\.assertMode\(\);\n/gm,'');
    else {
      if(!text.includes(coreError))fail();
      restored=text.replace(coreError,'');
    }
    ranges.push({start:node.getStart(tree),end:node.end,text:restored});
  }
  let restored=normalized;
  for(const range of ranges.sort((a,b)=>b.start-a.start))restored=restored.slice(0,range.start)+range.text+restored.slice(range.end);
  if(data){
    if(restored.split(modeImport).length!==2)fail();
    restored=restored.replace(modeImport,"import { getProviderMode } from './providerMode';");
    if(/this\.assertMode|assertProviderBinding|bindProviderMode|ProviderBinding/.test(restored))fail();
  }
  return restored;
}
