create table if not exists public.trade_records (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_date date not null,
  side text not null check (side in ('buy', 'sell')),
  btc_amount numeric not null check (btc_amount > 0),
  price_usdt numeric not null check (price_usdt > 0),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.trade_records enable row level security;

drop policy if exists "trade_records_select_own" on public.trade_records;
create policy "trade_records_select_own"
  on public.trade_records
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "trade_records_insert_own" on public.trade_records;
create policy "trade_records_insert_own"
  on public.trade_records
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "trade_records_update_own" on public.trade_records;
create policy "trade_records_update_own"
  on public.trade_records
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "trade_records_delete_own" on public.trade_records;
create policy "trade_records_delete_own"
  on public.trade_records
  for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_trade_records_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_trade_records_updated_at on public.trade_records;

create trigger set_trade_records_updated_at
  before update on public.trade_records
  for each row
  execute function public.set_trade_records_updated_at();
