create table public.drivers (
  stack_id text not null
    check (stack_id in ('arena', 'gauntlet_a', 'gauntlet_b')),
  id text not null,
  x integer not null check (x between 0 and 100),
  y integer not null check (y between 0 and 100),
  status text not null default 'idle'
    check (status in ('idle', 'enroute', 'ontrip')),
  primary key (stack_id, id)
);

alter table public.drivers enable row level security;

create table public.pricing_config (
  stack_id text primary key
    check (stack_id in ('arena', 'gauntlet_a', 'gauntlet_b')),
  per_mile_rate jsonb not null
    check (jsonb_typeof(per_mile_rate) in ('number', 'string')),
  surge double precision not null check (surge > 0),
  base_fare double precision not null check (base_fare > 0)
);

alter table public.pricing_config enable row level security;

grant select, insert, update, delete on table public.drivers to service_role;
grant select, insert, update, delete on table public.pricing_config to service_role;
