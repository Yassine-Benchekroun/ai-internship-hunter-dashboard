-- Step 8 follow-up — cover the monitor event application foreign key.
begin;

create index if not exists application_monitor_events_application_idx
  on public.application_monitor_events (application_id);

commit;
