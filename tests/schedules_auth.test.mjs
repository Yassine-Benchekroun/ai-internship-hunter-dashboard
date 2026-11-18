import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../supabase/functions/_shared/schedule.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/^import .+;\r?\n/gm, ''), { mode: 'transform' });
const runtime = await import(`data:text/javascript;base64,${Buffer.from(`
let client; let environment;
export function configure(c,e) { client=c; environment=e; }
const createClient = () => client;
const Deno = { env: { get: name => environment[name] } };
${executable}`).toString('base64')}`);
const environment = { SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-server-key' };
function backend({valid=true,ticketUser=null}={}) {
  const calls=[];
  return { calls, auth:{getUser:async token=>{calls.push(['auth',token]);return valid?{data:{user:{id:'owner-id'}},error:null}:{data:{user:null},error:{}};}},
    from:table=>({ select:()=>({ eq:(key,id)=>({maybeSingle:async()=>{calls.push(['settings',id]);return {data:{user_id:id},error:null};}})}) }),
    rpc:async(name,args)=>{calls.push([name,args]);return {data:ticketUser?{user_id:ticketUser}:null,error:null};} };
}
const request = (body={},headers={}) => new Request('https://test/schedule',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('authenticated account derives only from validated token; user_id is always rejected', async()=>{
  const client=backend();runtime.configure(client,environment);
  const context=await runtime.authorizeSchedule(request({}, {Authorization:'Bearer session'}),'profile_sync');
  assert.equal(context.userId,'owner-id');
  await assert.rejects(runtime.authorizeSchedule(request({user_id:'owner-id'},{Authorization:'Bearer session'}),'profile_sync'),/server_controlled/);
  assert.equal(client.calls.filter(c=>c[0]==='auth').length,1);
});
test('anonymous, invalid session and failed ticket requests cannot read account settings',async()=>{
  const client=backend({valid:false});runtime.configure(client,environment);
  await assert.rejects(runtime.authorizeSchedule(request(),'profile_sync'),/unauthorized/);
  await assert.rejects(runtime.authorizeSchedule(request({}, {Authorization:'Bearer invalid'}),'profile_sync'),/unauthorized/);
  await assert.rejects(runtime.authorizeSchedule(request({}, {'x-schedule-ticket':'a'.repeat(64)}),'application_monitor'),/unauthorized/);
  assert.equal(client.calls.filter(c=>c[0]==='settings').length,0);
});
test('server tickets are scoped by endpoint type and never accept caller ownership',async()=>{
  const client=backend({ticketUser:'configured-owner'});runtime.configure(client,environment);
  const context=await runtime.authorizeSchedule(request({}, {'x-schedule-ticket':'a'.repeat(64)}),'profile_sync');
  assert.equal(context.userId,'configured-owner');
  assert.equal(client.calls[0][1].p_schedule_type,'profile_sync');
  await assert.rejects(runtime.authorizeSchedule(request({}, {'x-schedule-ticket':'a'.repeat(64)})),/unauthorized/);
});
test('logs accept numeric counters and safe codes only',async()=>{
  const client=backend();runtime.configure(client,environment);
  await runtime.finishRun(client,{run_id:'run'},'failed',{processed_records:2,secret:'token',negative:-2},['source_failed','Bearer private-token']);
  const args=client.calls[0][1];
  assert.deepEqual(args.p_counts,{processed_records:2});
  assert.deepEqual(args.p_errors,['source_failed','operation_failed']);
  assert.doesNotMatch(JSON.stringify(args),/private-token/);
});
