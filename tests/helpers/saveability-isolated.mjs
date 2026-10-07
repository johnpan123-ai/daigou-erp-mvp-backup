import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import { CANONICAL_FRESH_INSTALL_V3 } from '../../supabase/canonicalFreshInstallV3.mjs';

export const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const owner='00000000-0000-4000-8000-000000000099';
export const viewer='00000000-0000-4000-8000-000000000098';
export async function isolatedDatabase({migrations=CANONICAL_FRESH_INSTALL_V3}={}) {
  const base=new URL(process.env.WACA_ISOLATED_PG_URL||'invalid:');
  assert.equal(base.hostname,'127.0.0.1'); assert.equal(base.port,'55492');
  assert.ok(base.pathname.startsWith('/waca_v3_'));
  const name=`waca_v3_save_${randomBytes(4).toString('hex')}`;
  const adminUrl=new URL(base); adminUrl.pathname='/postgres';
  const url=new URL(base); url.pathname='/'+name;
  const admin=new pg.Client({connectionString:adminUrl.toString()}); await admin.connect();
  await admin.query(`create database ${name}`);
  const sql=new pg.Client({connectionString:url.toString()}); await sql.connect();
  let server; const port=4399; const secret=randomBytes(32).toString('hex');
  const token=sub=>{
    const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const b=Buffer.from(JSON.stringify({role:'authenticated',sub,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
    const data=a+'.'+b; return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
  };
  const close=async()=>{
    if(server) { server.kill(); await sql.query("notify pgrst, 'reload config'").catch(()=>{}); }
    await sql.end(); await admin.query(`drop database ${name} with (force)`); await admin.end();
  };
  try {
    await sql.query(`create schema extensions; create extension pgcrypto with schema extensions;
      do $$ begin
        if to_regrole('anon') is null then create role anon nologin; end if;
        if to_regrole('authenticated') is null then create role authenticated nologin; end if;
        if to_regrole('service_role') is null then create role service_role nologin; end if;
      end $$;
      create schema auth; create schema storage; create schema realtime;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claim.sub',true),'')::uuid,
          (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid) $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
      create publication supabase_realtime;`);
    for(const file of migrations) await sql.query(readFileSync('supabase/sql/'+file,'utf8'));
    await sql.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'owner@example.invalid','{}'),($2,'viewer@example.invalid','{}')",[owner,viewer]);
    await sql.query("update public.profiles set role='owner' where user_id=$1",[owner]);
    await sql.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    await sql.query("insert into public.product_groups(id,title) values($1,'Synthetic group')",[uuid(1)]);
    await sql.query("insert into public.product_variants(id,product_group_id,myacg_item_code,product_title,variant_name) values($1,$2,'G-SYNTHETIC','Synthetic group','A')",[uuid(2),uuid(1)]);
  } catch(error){ await close(); throw error; }
  const http=async(path,body,sub=owner,options={})=>{
    // Undici overwrites Host. A native loopback request models the production
    // target header without DNS/network access to the real project.
    if(options.headers?.host) return new Promise((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port,path,method:options.method??(body===undefined?'GET':'POST'),headers:{
        ...options.headers,...(sub?{authorization:'Bearer '+token(sub)}:{}),
        ...(body===undefined?{}:{'content-type':'application/json'}),
      }},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);
        response.on('end',()=>{try{resolve({status:response.statusCode,data:text?JSON.parse(text):null});}catch(error){reject(error);}});
      });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
    const response=await fetch(`http://127.0.0.1:${port}`+path,{method:options.method??(body===undefined?'GET':'POST'),headers:{
      ...options.headers,
      ...(sub?{authorization:'Bearer '+token(sub)}:{}),...(body===undefined?{}:{'content-type':'application/json'}),
    },body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    return {status:response.status,data:text?JSON.parse(text):null};
  };
  return {sql,url,close,http,async startPostgrest(){
    server=spawn('wsl.exe',['-e','env','PGRST_DB_URI='+url.toString(),'PGRST_DB_SCHEMAS=public',
      'PGRST_DB_ANON_ROLE=anon','PGRST_JWT_SECRET='+secret,'PGRST_SERVER_HOST=127.0.0.1',
      'PGRST_SERVER_PORT='+port,'/tmp/hippo-waca-v3-postgrest-bin/postgrest'],{stdio:'ignore'});
    for(let n=0;n<60;n++){
      try{const r=await http('/'); if(r.status===200)return;}catch{}
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error('Disposable PostgREST not ready');
  }};
}
