// Local PostgreSQL/WASM validation, never connects to Supabase or Gmail.
// Install @electric-sql/pglite@0.5.16 in a disposable directory, then pass its
// package directory as argv[2]. pg_net transport and pg_cron registration are mocked.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDir = process.argv[2] || path.resolve('node_modules/@electric-sql/pglite');
const { PGlite } = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
const { pgcrypto } = await import(pathToFileURL(path.join(packageDir, 'dist/contrib/pgcrypto.js')));
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text,created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    create schema net;
    create table net.test_http_requests(id bigint generated always as identity primary key,url text,body jsonb,headers jsonb);
    create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 1000) returns bigint language plpgsql as $$
      declare request_id bigint; begin
        insert into net.test_http_requests(url,body,headers) values(url,body,headers) returning id into request_id;
        return request_id;
      end $$;
    insert into auth.users(id,email) values('3a419f7d-36e0-43d5-aa39-156b3177b84a','fixture@example.org');
  `);
  await db.exec(await readFile('supabase-schema.sql', 'utf8'));
  for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    let sql = await readFile(path.join('supabase/migrations', file), 'utf8');
    sql = sql.replace('create extension if not exists pg_net;', '-- pg_net transport mocked locally');
    try { await db.exec(sql); }
    catch (error) { console.error(`Migration failed: ${file}`); throw error; }
  }
  await db.exec(`insert into public.user_settings(user_id) values('3a419f7d-36e0-43d5-aa39-156b3177b84a') on conflict do nothing;`);
  const result = await db.exec(await readFile('supabase/tests/independent_schedules.sql', 'utf8'));
  for (const item of result) if (item.rows?.length) console.log(item.rows);
  await db.exec('begin; set local role service_role;');
  const liveRun = (await db.query(`select public.automation_begin_schedule('3a419f7d-36e0-43d5-aa39-156b3177b84a','profile_sync',gen_random_uuid(),true,'[]') as value`)).rows[0].value;
  await db.query('select public.automation_finish_schedule($1,$2,$3,$4)', [liveRun.run_id, 'blocked', {}, ['source_unavailable']]);
  const ingested = (await db.query(`select public.automation_ingest_opportunities($1) as value`, [{user_id:'3a419f7d-36e0-43d5-aa39-156b3177b84a',opportunities:[{organization:'Fixture',position:'AI research intern',source_url:'https://example.org/role-check',domain_relevant:true,match_score:68}]}])).rows[0].value;
  if (!ingested.accepted?.length) throw new Error('Service role ingestion failed');
  await db.query('select public.automation_prepare_artifacts($1,$2,$3,$4,$5)', ['3a419f7d-36e0-43d5-aa39-156b3177b84a',ingested.accepted[0].opportunity_id,{content:'Verified CV with \\ and Unicode é'}, {body:'Draft with \\ and Unicode é'}, 'role-test']);
  await db.exec('rollback');
  console.log('Service-role run and artifact contract permissions passed.');
  // Real ticket hashing, atomic consumption, expiry, and scope; transport mocked.
  await db.exec('begin');
  const dispatch = await db.query(`select private.dispatch_schedule('3a419f7d-36e0-43d5-aa39-156b3177b84a','profile_sync',true) as id`);
  const request = (await db.query('select * from net.test_http_requests where id=$1', [dispatch.rows[0].id])).rows[0];
  const ticket = request.headers['x-schedule-ticket'];
  const wrong = (await db.query('select public.automation_consume_schedule_ticket($1,$2) as value', [ticket,'application_monitor'])).rows[0].value;
  const accepted = (await db.query('select public.automation_consume_schedule_ticket($1,$2) as value', [ticket,'profile_sync'])).rows[0].value;
  const replay = (await db.query('select public.automation_consume_schedule_ticket($1,$2) as value', [ticket,'profile_sync'])).rows[0].value;
  if (wrong !== null || !accepted?.user_id || replay !== null) throw new Error('Ticket scope/replay test failed');
  await db.exec('rollback');
  console.log('Ticket scope/replay tests passed. pg_net transport and hosted role defaults still require deployment verification.');
  await db.exec(await readFile('supabase/tests/schedule_dispatch.sql', 'utf8'));
  console.log('Disabled-by-default recurrence, three independent jobs, dependency order and bounded retries passed (pg_cron registration mocked).');
} catch (error) {
  console.error({ message: error.message, detail: error.detail, where: error.where });
  process.exitCode = 1;
} finally { await db.close(); }
