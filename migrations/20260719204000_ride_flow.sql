create table public.trips (
  stack_id text not null
    check (stack_id in ('arena', 'gauntlet_a', 'gauntlet_b')),
  id text not null,
  rider_id text not null,
  driver_id text,
  pickup_x integer not null check (pickup_x between 0 and 100),
  pickup_y integer not null check (pickup_y between 0 and 100),
  dest_x integer not null check (dest_x between 0 and 100),
  dest_y integer not null check (dest_y between 0 and 100),
  distance integer not null check (distance >= 0),
  quote double precision not null,
  surge double precision not null,
  status text not null
    check (status in ('requested', 'matched', 'enroute', 'completed')),
  fare double precision,
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  primary key (stack_id, id),
  foreign key (stack_id, driver_id)
    references public.drivers (stack_id, id)
);

alter table public.trips enable row level security;

create index trips_stack_status_idx
  on public.trips (stack_id, status);

create table public.payments (
  stack_id text not null
    check (stack_id in ('arena', 'gauntlet_a', 'gauntlet_b')),
  id text not null,
  trip_id text not null,
  amount double precision not null check (amount > 0 and amount < 500),
  status text not null check (status = 'captured'),
  captured_at timestamp with time zone not null default now(),
  primary key (stack_id, id),
  unique (stack_id, trip_id),
  foreign key (stack_id, trip_id)
    references public.trips (stack_id, id)
);

alter table public.payments enable row level security;

grant select, insert, update, delete on table public.trips to service_role;
grant select, insert, update, delete on table public.payments to service_role;
