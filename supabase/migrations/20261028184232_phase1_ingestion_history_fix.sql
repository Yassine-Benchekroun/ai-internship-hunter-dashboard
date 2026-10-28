-- Allow ingestion audit rows to survive opportunity deletion.
-- The original manually-created audit table made opportunity_id NOT NULL;
-- SET NULL foreign-key behavior requires this column to be nullable.

begin;

alter table public.opportunity_ingestion_events
  alter column opportunity_id drop not null;

commit;
