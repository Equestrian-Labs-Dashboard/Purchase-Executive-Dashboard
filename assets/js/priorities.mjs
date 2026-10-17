export const fields=['priority','vendor','markup','sellThrough','unitsGoal','successMeasure','successLooksLike','status','nextStep','results'];
export const statuses=['To do','In progress','Done','On hold'];
export function emptyPlan(month) {return {month,version:0,rows:Array.from({length:5},(_,i)=>({id:`${month}-${i+1}`,priority:'',vendor:'',markup:'',sellThrough:'',unitsGoal:'',successMeasure:'',successLooksLike:'',status:'To do',nextStep:'',results:''}))};}
export function validatePlan(value) {
  if(!value||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)||!Array.isArray(value.rows)||value.rows.length>5||!Number.isSafeInteger(value.version)||value.version<0)throw Error('Invalid plan: use a monthly plan with up to five priorities.');
  const ids=new Set();
  const rows=value.rows.map(r=>{
    if(!r||typeof r.id!=='string'||r.id.length>100||ids.has(r.id))throw Error('Invalid priority identity');ids.add(r.id);
    const out={id:r.id};
    if(r.carriedFrom)out.carriedFrom=String(r.carriedFrom).slice(0,100);
    for(const f of fields){if(typeof r[f]!=='string'||r[f].length>2000)throw Error('Invalid priority field');out[f]=r[f];}
    if(!statuses.includes(out.status))throw Error('Invalid status');
    for(const f of ['markup','sellThrough','unitsGoal'])if(out[f]!==''&&(!Number.isFinite(Number(out[f]))||Number(out[f])<0||f==='sellThrough'&&Number(out[f])>100||f==='unitsGoal'&&!Number.isInteger(Number(out[f]))))throw Error('Invalid numeric goal');
    return out;
  });
  while(rows.length<5){let id=`${value.month}-blank-${rows.length}`;while(ids.has(id))id+='x';ids.add(id);rows.push({...emptyPlan(value.month).rows[rows.length],id});}
  return {month:value.month,version:value.version,rows};
}
export function nextMonth(month){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);}
export function carryForward(source,target) {
  source=validatePlan(source);target=validatePlan(target);
  if(target.month!==nextMonth(source.month))throw Error('Carry forward requires the next month');
  const existing=target.rows.filter(r=>r.priority.trim());
  const incoming=source.rows.filter(r=>r.priority.trim()&&r.status!=='Done'&&!existing.some(x=>x.carriedFrom===r.id));
  if(existing.length+incoming.length>5)throw Error('Next month has fewer free slots than unfinished priorities. Nothing was overwritten.');
  const usedIds=new Set(existing.map(r=>r.id));
  const rows=[...existing,...incoming.map((r,i)=>{let id=`${target.month}-carried-${i}`;while(usedIds.has(id))id+='x';usedIds.add(id);return {...r,id,carriedFrom:r.id,results:''};})];
  while(rows.length<5){let id=`${target.month}-blank-${rows.length}`;while(usedIds.has(id))id+='x';usedIds.add(id);rows.push({...emptyPlan(target.month).rows[rows.length],id});}
  return {...target,rows};
}
