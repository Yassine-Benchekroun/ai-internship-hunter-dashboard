-- Step 7: backend-only Gmail OAuth connection state.
-- No mail is sent here. Tokens and OAuth state stay outside exposed schemas.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.provider_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists provider_oauth_states_expiry_idx
  on private.provider_oauth_states (expires_at);

create table if not exists private.provider_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  account_email text check (account_email is null or char_length(account_email) <= 320),
  access_token text,
  refresh_token text,
  token_type text not null default 'Bearer',
  scopes text[] not null default '{}'::text[],
  access_token_expires_at timestamptz,
  status text not null default 'not_connected'
    check (status in ('not_connected', 'connected', 'revoked', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create index if not exists provider_connections_status_idx
  on private.provider_connections (status, updated_at desc);

alter table private.provider_oauth_states enable row level security;
alter table private.provider_connections enable row level security;
revoke all on table private.provider_oauth_states, private.provider_connections from public, anon, authenticated;
grant select, insert, update, delete on table private.provider_oauth_states, private.provider_connections to service_role;

create or replace function private.provider_oauth_begin_impl(
  p_user_id uuid,
  p_provider text,
  p_state_hash text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then raise exception 'OAuth user is required'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'OAuth user does not exist';
  end if;
  if lower(trim(coalesce(p_provider, ''))) <> 'gmail' then
    raise exception 'Unsupported OAuth provider';
  end if;
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid OAuth state hash';
  end if;
  if p_redirect_uri is null or char_length(p_redirect_uri) > 2048 then
    raise exception 'Invalid OAuth redirect URI';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'Invalid OAuth state expiry';
  end if;

  delete from private.provider_oauth_states
  where user_id = p_user_id or expires_at <= now();

  insert into private.provider_oauth_states (user_id, provider, state_hash, redirect_uri, expires_at)
  values (p_user_id, 'gmail', p_state_hash, p_redirect_uri, p_expires_at);
end;
$$;

create or replace function private.provider_oauth_consume_impl(p_state_hash text)
returns table(user_id uuid, provider text, redirect_uri text)
language sql
security definer
set search_path = ''
as $$
  delete from private.provider_oauth_states
  where state_hash = p_state_hash
    and expires_at > now()
  returning provider_oauth_states.user_id, provider_oauth_states.provider, provider_oauth_states.redirect_uri;
$$;

create or replace function private.provider_oauth_get_connection_impl(p_user_id uuid)
returns table(
  provider text,
  account_email text,
  access_token text,
  refresh_token text,
  token_type text,
  scopes text[],
  access_token_expires_at timestamptz,
  status text,
  last_error text
)
language sql
stable
security definer
set search_path = ''
as $$
  select provider, account_email, access_token, refresh_token, token_type, scopes,
         access_token_expires_at, status, last_error
  from private.provider_connections
  where user_id = p_user_id and provider = 'gmail';
$$;

create or replace function private.provider_oauth_store_connection_impl(
  p_user_id uuid,
  p_provider text,
  p_account_email text,
  p_access_token text,
  p_refresh_token text,
  p_token_type text,
  p_scopes text[],
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or lower(trim(coalesce(p_provider, ''))) <> 'gmail' then
    raise exception 'Invalid provider connection';
  end if;
  if p_access_token is null or char_length(p_access_token) > 4096 then
    raise exception 'Access token is required';
  end if;
  if p_refresh_token is not null and char_length(p_refresh_token) > 4096 then
    raise exception 'Refresh token is too large';
  end if;
  if p_account_email is not null and char_length(p_account_email) > 320 then
    raise exception 'Provider account email is too large';
  end if;

  insert into private.provider_connections (
    user_id, provider, account_email, access_token, refresh_token, token_type,
    scopes, access_token_expires_at, status, last_error
  ) values (
    p_user_id, 'gmail', nullif(trim(p_account_email), ''), p_access_token,
    p_refresh_token, coalesce(nullif(trim(p_token_type), ''), 'Bearer'),
    coalesce(p_scopes, '{}'::text[]), p_access_token_expires_at, 'connected', null
  )
  on conflict (user_id, provider) do update set
    account_email = excluded.account_email,
    access_token = excluded.access_token,
    refresh_token = coalesce(excluded.refresh_token, private.provider_connections.refresh_token),
    token_type = excluded.token_type,
    scopes = excluded.scopes,
    access_token_expires_at = excluded.access_token_expires_at,
    status = 'connected',
    last_error = null,
    updated_at = now();

  insert into public.user_settings (user_id, provider_connection_status)
  values (p_user_id, 'connected')
  on conflict (user_id) do update set
    provider_connection_status = 'connected',
    updated_at = now();
end;
$$;

create or replace function private.provider_oauth_revoke_connection_impl(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.provider_connections
  set access_token = null,
      refresh_token = null,
      status = 'revoked',
      last_error = null,
      updated_at = now()
  where user_id = p_user_id and provider = 'gmail';

  insert into public.user_settings (user_id, provider_connection_status)
  values (p_user_id, 'revoked')
  on conflict (user_id) do update set
    provider_connection_status = 'revoked',
    updated_at = now();
end;
$$;

create or replace function private.provider_oauth_mark_error_impl(p_user_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.provider_connections (user_id, provider, status, last_error)
  values (p_user_id, 'gmail', 'error', left(nullif(trim(p_error), ''), 500))
  on conflict (user_id, provider) do update set
    status = 'error',
    last_error = left(nullif(trim(p_error), ''), 500),
    updated_at = now();

  insert into public.user_settings (user_id, provider_connection_status)
  values (p_user_id, 'error')
  on conflict (user_id) do update set
    provider_connection_status = 'error',
    updated_at = now();
end;
$$;

create or replace function public.provider_oauth_begin(
  p_user_id uuid, p_provider text, p_state_hash text, p_redirect_uri text, p_expires_at timestamptz
)
returns void language sql security invoker set search_path = ''
as $$ select private.provider_oauth_begin_impl($1, $2, $3, $4, $5); $$;

create or replace function public.provider_oauth_consume(p_state_hash text)
returns table(user_id uuid, provider text, redirect_uri text)
language sql security invoker set search_path = ''
as $$ select * from private.provider_oauth_consume_impl($1); $$;

create or replace function public.provider_oauth_get_connection(p_user_id uuid)
returns table(
  provider text, account_email text, access_token text, refresh_token text,
  token_type text, scopes text[], access_token_expires_at timestamptz,
  status text, last_error text
)
language sql security invoker set search_path = ''
as $$ select * from private.provider_oauth_get_connection_impl($1); $$;

create or replace function public.provider_oauth_store_connection(
  p_user_id uuid, p_provider text, p_account_email text, p_access_token text,
  p_refresh_token text, p_token_type text, p_scopes text[], p_access_token_expires_at timestamptz
)
returns void language sql security invoker set search_path = ''
as $$ select private.provider_oauth_store_connection_impl($1, $2, $3, $4, $5, $6, $7, $8); $$;

create or replace function public.provider_oauth_revoke_connection(p_user_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.provider_oauth_revoke_connection_impl($1); $$;

create or replace function public.provider_oauth_mark_error(p_user_id uuid, p_error text)
returns void language sql security invoker set search_path = ''
as $$ select private.provider_oauth_mark_error_impl($1, $2); $$;

revoke all on function private.provider_oauth_begin_impl(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.provider_oauth_consume_impl(text) from public, anon, authenticated;
revoke all on function private.provider_oauth_get_connection_impl(uuid) from public, anon, authenticated;
revoke all on function private.provider_oauth_store_connection(uuid, text, text, text, text, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function private.provider_oauth_revoke_connection_impl(uuid) from public, anon, authenticated;
revoke all on function private.provider_oauth_mark_error_impl(uuid, text) from public, anon, authenticated;
grant execute on function private.provider_oauth_begin_impl(uuid, text, text, text, timestamptz) to service_role;
grant execute on function private.provider_oauth_consume_impl(text) to service_role;
grant execute on function private.provider_oauth_get_connection_impl(uuid) to service_role;
grant execute on function private.provider_oauth_store_connection(uuid, text, text, text, text, text, text[], timestamptz) to service_role;
grant execute on function private.provider_oauth_revoke_connection_impl(uuid) to service_role;
grant execute on function private.provider_oauth_mark_error_impl(uuid, text) to service_role;

revoke all on function public.provider_oauth_begin(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.provider_oauth_consume(text) from public, anon, authenticated;
revoke all on function public.provider_oauth_get_connection(uuid) from public, anon, authenticated;
revoke all on function public.provider_oauth_store_connection(uuid, text, text, text, text, text, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.provider_oauth_revoke_connection(uuid) from public, anon, authenticated;
revoke all on function public.provider_oauth_mark_error(uuid, text) from public, anon, authenticated;
grant execute on function public.provider_oauth_begin(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.provider_oauth_consume(text) to service_role;
grant execute on function public.provider_oauth_get_connection(uuid) to service_role;
grant execute on function public.provider_oauth_store_connection(uuid, text, text, text, text, text, text[], timestamptz) to service_role;
grant execute on function public.provider_oauth_revoke_connection(uuid) to service_role;
grant execute on function public.provider_oauth_mark_error(uuid, text) to service_role;

comment on table private.provider_connections is
  'Backend-only Gmail OAuth tokens; never exposed through browser tables or public assets.';
comment on table private.provider_oauth_states is
  'Single-use hashed OAuth state values; never stores the browser state in plaintext.';

commit;
