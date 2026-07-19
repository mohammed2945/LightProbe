drop extension if exists "pg_net";


  create table "public"."active_faults" (
    "id" bigint generated always as identity not null,
    "ts" timestamp with time zone default now(),
    "stack_id" text not null,
    "fault" text not null,
    "cleared_at" timestamp with time zone
      );


alter table "public"."active_faults" enable row level security;


  create table "public"."events" (
    "id" bigint generated always as identity not null,
    "ts" timestamp with time zone default now(),
    "stack_id" text not null,
    "service" text not null,
    "trace_id" text,
    "kind" text not null,
    "payload" jsonb default '{}'::jsonb
      );


alter table "public"."events" enable row level security;


  create table "public"."origin_events" (
    "id" bigint generated always as identity not null,
    "ts" timestamp with time zone default now(),
    "stack_id" text not null,
    "incident_id" text not null,
    "kind" text not null,
    "payload" jsonb not null
      );


alter table "public"."origin_events" enable row level security;

CREATE UNIQUE INDEX active_faults_pkey ON public.active_faults USING btree (id);

CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id);

CREATE UNIQUE INDEX origin_events_pkey ON public.origin_events USING btree (id);

alter table "public"."active_faults" add constraint "active_faults_pkey" PRIMARY KEY using index "active_faults_pkey";

alter table "public"."events" add constraint "events_pkey" PRIMARY KEY using index "events_pkey";

alter table "public"."origin_events" add constraint "origin_events_pkey" PRIMARY KEY using index "origin_events_pkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_fault_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if exists (select 1 from active_faults where stack_id = new.stack_id and cleared_at is null) then
    raise exception 'fault already active on this stack';
  end if;
  if exists (select 1 from active_faults where stack_id = new.stack_id and ts > now() - interval '45 seconds') then
    raise exception 'cooldown';
  end if;
  return new;
end; $function$
;

create or replace view "public"."stack_health" as  SELECT stack_id,
    count(*) FILTER (WHERE ((kind = 'error'::text) AND (ts > (now() - '00:10:00'::interval)))) AS errors_10m,
    round((100.0 * ((1)::numeric - ((count(*) FILTER (WHERE ((kind = 'error'::text) AND (ts > (now() - '00:10:00'::interval)))))::numeric / (GREATEST(count(*) FILTER (WHERE ((kind = 'request'::text) AND (ts > (now() - '00:10:00'::interval)))), (1)::bigint))::numeric))), 1) AS uptime_pct,
    COALESCE(( SELECT ((e2.payload ->> 'value'::text))::integer AS int4
           FROM public.events e2
          WHERE ((e2.stack_id = events.stack_id) AND (e2.kind = 'metric'::text) AND ((e2.payload ->> 'metric_name'::text) = 'stranded_count'::text))
          ORDER BY e2.ts DESC
         LIMIT 1), 0) AS stranded_now
   FROM public.events
  GROUP BY stack_id;


grant delete on table "public"."active_faults" to "anon";

grant insert on table "public"."active_faults" to "anon";

grant references on table "public"."active_faults" to "anon";

grant select on table "public"."active_faults" to "anon";

grant trigger on table "public"."active_faults" to "anon";

grant truncate on table "public"."active_faults" to "anon";

grant update on table "public"."active_faults" to "anon";

grant delete on table "public"."active_faults" to "authenticated";

grant insert on table "public"."active_faults" to "authenticated";

grant references on table "public"."active_faults" to "authenticated";

grant select on table "public"."active_faults" to "authenticated";

grant trigger on table "public"."active_faults" to "authenticated";

grant truncate on table "public"."active_faults" to "authenticated";

grant update on table "public"."active_faults" to "authenticated";

grant delete on table "public"."active_faults" to "service_role";

grant insert on table "public"."active_faults" to "service_role";

grant references on table "public"."active_faults" to "service_role";

grant select on table "public"."active_faults" to "service_role";

grant trigger on table "public"."active_faults" to "service_role";

grant truncate on table "public"."active_faults" to "service_role";

grant update on table "public"."active_faults" to "service_role";

grant delete on table "public"."events" to "anon";

grant insert on table "public"."events" to "anon";

grant references on table "public"."events" to "anon";

grant select on table "public"."events" to "anon";

grant trigger on table "public"."events" to "anon";

grant truncate on table "public"."events" to "anon";

grant update on table "public"."events" to "anon";

grant delete on table "public"."events" to "authenticated";

grant insert on table "public"."events" to "authenticated";

grant references on table "public"."events" to "authenticated";

grant select on table "public"."events" to "authenticated";

grant trigger on table "public"."events" to "authenticated";

grant truncate on table "public"."events" to "authenticated";

grant update on table "public"."events" to "authenticated";

grant delete on table "public"."events" to "service_role";

grant insert on table "public"."events" to "service_role";

grant references on table "public"."events" to "service_role";

grant select on table "public"."events" to "service_role";

grant trigger on table "public"."events" to "service_role";

grant truncate on table "public"."events" to "service_role";

grant update on table "public"."events" to "service_role";

grant delete on table "public"."origin_events" to "anon";

grant insert on table "public"."origin_events" to "anon";

grant references on table "public"."origin_events" to "anon";

grant select on table "public"."origin_events" to "anon";

grant trigger on table "public"."origin_events" to "anon";

grant truncate on table "public"."origin_events" to "anon";

grant update on table "public"."origin_events" to "anon";

grant delete on table "public"."origin_events" to "authenticated";

grant insert on table "public"."origin_events" to "authenticated";

grant references on table "public"."origin_events" to "authenticated";

grant select on table "public"."origin_events" to "authenticated";

grant trigger on table "public"."origin_events" to "authenticated";

grant truncate on table "public"."origin_events" to "authenticated";

grant update on table "public"."origin_events" to "authenticated";

grant delete on table "public"."origin_events" to "service_role";

grant insert on table "public"."origin_events" to "service_role";

grant references on table "public"."origin_events" to "service_role";

grant select on table "public"."origin_events" to "service_role";

grant trigger on table "public"."origin_events" to "service_role";

grant truncate on table "public"."origin_events" to "service_role";

grant update on table "public"."origin_events" to "service_role";


  create policy "insert_faults"
  on "public"."active_faults"
  as permissive
  for insert
  to public
with check ((stack_id = ANY (ARRAY['arena'::text, 'gauntlet_a'::text, 'gauntlet_b'::text])));



  create policy "read_all_faults"
  on "public"."active_faults"
  as permissive
  for select
  to public
using (true);



  create policy "read_all_events"
  on "public"."events"
  as permissive
  for select
  to public
using (true);



  create policy "read_all_origin"
  on "public"."origin_events"
  as permissive
  for select
  to public
using (true);


CREATE TRIGGER fault_gate BEFORE INSERT ON public.active_faults FOR EACH ROW EXECUTE FUNCTION public.check_fault_insert();


