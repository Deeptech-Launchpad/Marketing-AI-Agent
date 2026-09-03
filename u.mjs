import pg from 'pg'
const c=new pg.Client({connectionString:'postgresql://postgres:postgres@127.0.0.1:5433/nxt_marketwiz_dev'})
await c.connect()
const u=await c.query(`SELECT id, email, name, role, status FROM "User" ORDER BY name`)
console.log('Users in the restored snapshot:', u.rows.length)
for (const r of u.rows) console.log(`  ${String(r.name).padEnd(22)} ${String(r.email).padEnd(34)} ${r.role} ${r.status}`)
const svc = u.rows.filter(r => /service|agent|bot|marketing-agent|system|api/i.test(r.email + ' ' + r.name))
console.log(`\nService-account-shaped rows: ${svc.length}`)
console.log(svc.length ? svc.map(r=>'  '+r.email).join('\n') : '  none — every account is a named person')
