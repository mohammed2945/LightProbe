import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DataSource, ArenaEvent, StackId, FaultType, StackHealthRow, WorldTickPayload } from '../types';
import { toast } from './toasts';

// Get Supabase Client Lazily to prevent startup crashes if environment variables are not set
let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseInstance) {
    const url = (import.meta as any).env?.VITE_SUPABASE_URL;
    const key = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) {
      return null;
    }
    supabaseInstance = createClient(url, key);
  }
  return supabaseInstance;
}

interface Subscriber {
  listener: (event: ArenaEvent) => void;
  stackId?: StackId;
}

export class LiveDataSourceImpl implements DataSource {
  private subscribers: Subscriber[] = [];
  private activeChannel: any = null;
  private pollIntervalId: any = null;
  
  public selectedStackId: StackId = 'arena';
  
  public stackHealth: Record<StackId, StackHealthRow> = {
    arena: { stack_id: 'arena', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
    gauntlet_a: { stack_id: 'gauntlet_a', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
    gauntlet_b: { stack_id: 'gauntlet_b', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
  };

  private healthListeners: ((health: Record<StackId, StackHealthRow>) => void)[] = [];

  constructor() {}

  public subscribeHealth(listener: (health: Record<StackId, StackHealthRow>) => void) {
    this.healthListeners.push(listener);
    listener(this.stackHealth);
    return () => {
      this.healthListeners = this.healthListeners.filter(l => l !== listener);
    };
  }

  public async start() {
    const db = getSupabase();
    if (!db) {
      console.warn("LiveDataSource: Supabase not configured. Please supply VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY.");
      return;
    }

    // 1. Backfill last 200 events on load
    try {
      const { data, error } = await db
        .from('events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) {
        console.error("Failed to backfill events:", error);
      } else if (data) {
        // Reverse to maintain chronological order
        const events = data.map(row => this.mapRowToEvent(row)).reverse();
        events.forEach(event => this.emitToSubscribers(event));
      }
    } catch (err) {
      console.error("Backfill failed:", err);
    }

    // 2. Poll stack_health every 5s
    this.pollStackHealth();
    this.pollIntervalId = window.setInterval(() => {
      this.pollStackHealth();
    }, 5000);

    // 3. Realtime-subscribe to events, active_faults, origin_events
    this.activeChannel = db.channel('live_chaos_arena')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, (payload: any) => {
        if (payload.new) {
          const event = this.mapRowToEvent(payload.new);
          this.emitToSubscribers(event);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'active_faults' }, (payload: any) => {
        // active_faults: trigger fault_started or fault_cleared event mapped to Mock interfaces
        if (payload.eventType === 'INSERT' && payload.new) {
          const faultEvent: ArenaEvent = {
            ts: payload.new.ts || payload.new.created_at || new Date().toISOString(),
            stack_id: payload.new.stack_id || 'arena',
            service: this.getServiceForFault(payload.new.fault),
            kind: 'fault_started',
            payload: {
              fault: payload.new.fault,
              durationMs: payload.new.duration_ms || 45000
            }
          };
          this.emitToSubscribers(faultEvent);
        } else if ((payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') && payload.old) {
          const faultEvent: ArenaEvent = {
            ts: new Date().toISOString(),
            stack_id: payload.old.stack_id || 'arena',
            service: 'arena',
            kind: 'fault_cleared',
            payload: {
              fault: payload.old.fault || payload.new?.fault
            }
          };
          this.emitToSubscribers(faultEvent);
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'origin_events' }, (payload: any) => {
        if (payload.new) {
          const originEvent: ArenaEvent = {
            ts: payload.new.ts || payload.new.created_at || new Date().toISOString(),
            stack_id: payload.new.stack_id || 'arena',
            service: payload.new.service || 'origin_tracing',
            kind: payload.new.kind, // 'slice_ready', 'probes_armed', etc.
            payload: typeof payload.new.payload === 'string' ? JSON.parse(payload.new.payload) : payload.new.payload
          };
          this.emitToSubscribers(originEvent);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime subscribed successfully to events, active_faults, and origin_events');
        }
      });
  }

  public stop() {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.activeChannel) {
      const db = getSupabase();
      if (db) {
        db.removeChannel(this.activeChannel);
      }
      this.activeChannel = null;
    }
  }

  public subscribe(listener: (event: ArenaEvent) => void, stackId?: StackId) {
    const subscriber = { listener, stackId };
    this.subscribers.push(subscriber);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== subscriber);
    };
  }

  public async triggerFault(fault: FaultType) {
    const db = getSupabase();
    if (!db) {
      toast.show("Supabase connection unavailable", "error");
      return;
    }

    try {
      const { error } = await db
        .from('active_faults')
        .insert({ stack_id: this.selectedStackId, fault });

      if (error) {
        console.error("Database fault insertion failed:", error);
        // Handle constraint errors and display specified error strings as toasts
        const msg = error.message || "";
        if (msg.includes("beat you to it") || msg.includes("next attack")) {
          toast.show(msg, "error");
        } else {
          // Fallback or custom DB error toast
          toast.show(msg || "Someone beat you to it — 32s until the next attack", "error");
        }
      } else {
        toast.show(`Successfully triggered chaos fault: ${fault}`, "success");
      }
    } catch (err: any) {
      console.error("Fault insertion crashed:", err);
      toast.show(err?.message || "Someone beat you to it — 32s until the next attack", "error");
    }
  }

  private async pollStackHealth() {
    const db = getSupabase();
    if (!db) return;

    try {
      const { data, error } = await db
        .from('stack_health')
        .select('*');

      if (error) {
        console.error("Error fetching stack_health:", error);
      } else if (data) {
        data.forEach((row: any) => {
          this.stackHealth[row.stack_id as StackId] = {
            stack_id: row.stack_id,
            errors_10m: row.errors_10m ?? 0,
            uptime_pct: row.uptime_pct ?? 100,
            stranded_now: row.stranded_now ?? 0
          };
        });

        this.healthListeners.forEach(listener => listener({ ...this.stackHealth }));
      }
    } catch (err) {
      console.error("Stack health poll error:", err);
    }
  }

  private emitToSubscribers(event: ArenaEvent) {
    this.subscribers.forEach(({ listener, stackId }) => {
      // Filter client-side by selected stack_id or specific target stack_id
      const targetStackId = stackId || this.selectedStackId;
      if (event.stack_id === targetStackId) {
        listener(event);
      }
    });
  }

  private mapRowToEvent(row: any): ArenaEvent {
    let payload = row.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        console.error("Failed to parse row payload:", e);
      }
    }
    return {
      ts: row.ts || row.created_at || new Date().toISOString(),
      stack_id: row.stack_id,
      service: row.service || 'arena',
      trace_id: row.trace_id,
      kind: row.kind,
      payload
    };
  }

  private getServiceForFault(fault: FaultType): string {
    if (fault === 'bad_deploy') return 'gateway';
    if (fault === 'mem_leak') return 'location';
    if (fault === 'fare_corrupt' || fault === 'surge_poison') return 'payments';
    if (fault === 'double_dispatch') return 'matching';
    return 'postgres';
  }
}

export const liveDataSource = new LiveDataSourceImpl();
