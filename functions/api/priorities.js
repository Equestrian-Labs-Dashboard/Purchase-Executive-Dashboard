import {authorize} from '../_lib/authz.js';
import {canUseReport} from '../_lib/registry.js';
import {validatePlan,emptyPlan} from '../../assets/js/priorities.mjs';
const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function createPlanHandler({authorizeUser=authorize,canUse=canUseReport}={}) { return async function onRequest(context) {
  if(!context.env.PURCHASE_DB)return reply({error:'Shared storage is not configured; local browser mode is available.'},503);
  try{
    const {user}=await authorizeUser(context);
    if(!canUse(user,'purchase_executive'))return reply({error:'Purchase report access is required.'},403);
    const url=new URL(context.request.url),month=url.searchParams.get('month');
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))return reply({error:'A valid plan month is required.'},400);
    const db=context.env.PURCHASE_DB;
    if(context.request.method==='GET'){
      const row=await db.prepare('SELECT body,version FROM purchase_plans WHERE month=?1').bind(month).first();
      return reply(row?{...JSON.parse(row.body),version:row.version}:emptyPlan(month));
    }
    if(context.request.method!=='PUT')return reply({error:'Method not allowed'},405);
    if(context.request.headers.get('origin')!==url.origin)return reply({error:'Same-origin request required.'},403);
    if(!context.request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON required'},415);
    if(Number(context.request.headers.get('content-length'))>100000)return reply({error:'Plan too large'},413);
    const reader=context.request.body?.getReader();if(!reader)return reply({error:'JSON body required'},400);
    const parts=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>100000){await reader.cancel();return reply({error:'Plan too large'},413);}parts.push(value);}
    const text=await new Blob(parts).text();
    let plan;try{plan=validatePlan(JSON.parse(text));}catch(error){return reply({error:error.message},400);}
    if(plan.month!==month)return reply({error:'Plan month mismatch'},400);
    const body=JSON.stringify(plan),updated=new Date().toISOString();
    // Compare-and-swap avoids silently overwriting a colleague's saved changes.
    const stmt=plan.version===0
      ?db.prepare('INSERT INTO purchase_plans (month,body,version,updated_at,updated_by) VALUES (?1,?2,1,?3,?4) ON CONFLICT(month) DO NOTHING').bind(month,body,updated,user.email)
      :db.prepare('UPDATE purchase_plans SET body=?1,version=version+1,updated_at=?2,updated_by=?3 WHERE month=?4 AND version=?5').bind(body,updated,user.email,month,plan.version);
    const result=await stmt.run();
    if(result.meta.changes!==1)return reply({error:'Someone else saved this month. Back up your draft, reload the month, and merge your changes.'},409);
    return reply({...plan,version:plan.version+1});
  }catch(error){return reply({error:Number(error.status)<500?error.message:'Shared plan service is unavailable. Your local draft is preserved.'},Number(error.status)||500);}
}; }
export const onRequest=createPlanHandler();
