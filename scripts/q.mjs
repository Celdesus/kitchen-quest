import pg from 'pg'; const p = new pg.Pool({ host: 'localhost', port: 54329, user: 'postgres', password: 'postgres', database: 'kitchen_quest' });
const r = await p.query(process.argv[2]); console.table(r.rows); await p.end();
