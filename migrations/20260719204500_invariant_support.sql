alter table public.payments
  drop constraint if exists payments_amount_check;

create index if not exists trips_stack_status_created_idx
  on public.trips (stack_id, status, created_at);

create index if not exists events_stack_kind_ts_idx
  on public.events (stack_id, kind, ts desc);
