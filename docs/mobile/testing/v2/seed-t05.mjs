const A='http://localhost:8090/api/v1';
const j=async(m,u,b,t)=>{const r=await fetch(A+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return r.json().catch(()=>null)};
const t=(await j('POST','/auth/login',{username:'waiter1',password:'waiter123'})).access_token;
const rs=await j('GET','/resources',null,t);const r=rs.find(x=>x.code==='T05');
const tk=await j('POST','/tickets',{resource_id:r.id,ticket_type:'TABLE',customer_name:'e2e'},t);
const it=(await j('GET','/menu/items',null,t)).find(i=>i.name==='Soda');
console.log(await j('POST',`/tickets/${tk.id}/items`,{menu_item_id:it.id,quantity:1},t).then(x=>x&&x.id));
