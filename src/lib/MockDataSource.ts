import { DataSource, ArenaEvent, WorldTickPayload, EventKind, FaultType } from '../types';

const SERVICES = ['gateway', 'matching', 'pricing', 'trips', 'location', 'payments', 'postgres', 'redis'];
const MESSAGES = [
  "Rider requested pickup in Downtown",
  "Driver #402 accepted ride",
  "Traffic routing updated for Sector 4",
  "Fare calculation completed: $14.50",
  "GPS ping received from Vehicle #91",
  "Dispatching available drivers near Airport"
];

function moveTowards(current: number, target: number, speed: number) {
  if (current < target) return Math.min(current + speed, target);
  if (current > target) return Math.max(current - speed, target);
  return current;
}

export class MockDataSourceImpl implements DataSource {
  private intervals: number[] = [];
  private listeners: ((event: ArenaEvent) => void)[] = [];
  
  private tickCount = 0;
  
  private activeFault: { fault: FaultType, startedAt: number, durationMs: number } | null = null;
  private agentPlan: { steps: { time: number, kind: EventKind, payload: any }[] } | null = null;
  private hasManualFault = false;
  private memoryLeakPct = 0;
  private doubleDispatchFired = false;
  
  private drivers: any[] = Array.from({ length: 15 }, (_, i) => ({
    id: `d${i}`,
    x: Math.random() * 80 + 10,
    y: Math.random() * 80 + 10,
    heading: Math.random() * 360,
    st: 'idle',
  }));
  
  private riders: any[] = [];

  constructor() {}

  public triggerFault(fault: FaultType) {
    if (this.activeFault) {
      this.emit({ ts: new Date().toISOString(), stack_id: 'arena', service: 'arena', kind: 'fault_cleared', payload: { fault: this.activeFault.fault }});
    }
    
    this.hasManualFault = true;
    this.memoryLeakPct = 0;
    this.doubleDispatchFired = false;
    
    let service = 'postgres';
    if (fault === 'bad_deploy') service = 'gateway';
    else if (fault === 'mem_leak') service = 'location';
    else if (fault === 'fare_corrupt' || fault === 'surge_poison') service = 'payments';
    else if (fault === 'double_dispatch') service = 'matching';

    this.setupAgentPlan(fault, Date.now(), service);
  }

  private setupAgentPlan(fault: FaultType, now: number, service: string) {
    let actions: string[] = [];
    if (fault === 'db_kill') {
      actions = ["Scaling up Postgres connection pool.", "Killing idle connections.", "Connections stabilized."];
    } else if (fault === 'bad_deploy') {
      actions = ["Detected elevated 500s on Gateway.", "Identifying recent deployment diffs.", "Rolling back Gateway to previous stable version."];
    } else if (fault === 'mem_leak') {
      actions = ["Location service OOM risk detected.", "Capturing heap profile.", "Restarting affected location pods."];
    } else if (fault === 'surge_poison') {
      actions = ["Anomalous surge multiplier detected.", "Applying circuit breaker to pricing constraints.", "Resetting surge to baseline 1.0x."];
    } else if (fault === 'fare_corrupt') {
      actions = ["Fare validation mismatch on payments.", "Flushing corrupted fare cache.", "Replaying failed payment events."];
    } else if (fault === 'double_dispatch') {
      actions = ["Invariant breach detected: multiple active trips for single driver.", "Reassigning rider r_91 to driver d_3 — reconciling duplicate dispatch."];
    }
    
    const durationMs = 45000 + Math.random() * 15000;
    this.activeFault = { fault, startedAt: now, durationMs };
    
    this.emit({ ts: new Date(now).toISOString(), stack_id: 'arena', service, kind: 'fault_started', payload: { fault, durationMs }});
    
    const steps: any[] = [];
    let t1 = 12000;
    if (fault === 'fare_corrupt') t1 = 28000;
    
    steps.push({ time: now + t1, kind: 'agent_action', payload: { message: actions[0] } });
    
    if (actions.length > 2) {
       steps.push({ time: now + t1 + 10000, kind: 'agent_action', payload: { message: actions[1] } });
       steps.push({ time: now + durationMs - 2000, kind: 'agent_action', payload: { message: actions[2] } });
    } else {
       steps.push({ time: now + durationMs - 2000, kind: 'agent_action', payload: { message: actions[1] } });
    }
    steps.push({ time: now + durationMs, kind: 'fault_cleared', payload: { fault } });
    
    this.agentPlan = { steps };
  }

  start() {
    if (this.intervals.length > 0) return;
    
    // Request events interval (~3/sec)
    this.intervals.push(window.setInterval(() => {
      const now = Date.now();
      
      if (this.agentPlan) {
        const remaining = [];
        for (const step of this.agentPlan.steps) {
          if (now >= step.time) {
             this.emit({ ts: new Date().toISOString(), stack_id: 'arena', service: 'arena', kind: step.kind, payload: step.payload });
             if (step.kind === 'fault_cleared') {
                this.activeFault = null;
             }
          } else {
             remaining.push(step);
          }
        }
        this.agentPlan.steps = remaining;
        if (remaining.length === 0) this.agentPlan = null;
      }
      
      let faultType: FaultType | undefined;
      
      if (this.activeFault) {
         faultType = this.activeFault.fault;
      }

      let service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
      let kind: EventKind = 'request';
      let status = 200;
      let latency_ms = Math.floor(Math.random() * 150) + 20;

      if (faultType === 'db_kill') {
        if (Math.random() < 0.6) service = Math.random() < 0.5 ? 'trips' : 'matching';
        if (service === 'trips' || service === 'matching' || service === 'postgres') {
          status = 500;
          latency_ms = Math.floor(Math.random() * 4000) + 1000;
          if (Math.random() < 0.7) kind = 'error';
        }
      } 
      else if (faultType === 'bad_deploy') {
        if (Math.random() < 0.8) service = 'gateway';
        if (service === 'gateway') {
          status = 500;
          latency_ms = Math.floor(Math.random() * 2000) + 500;
          if (Math.random() < 0.8) kind = 'error';
        }
      }
      else if (faultType === 'mem_leak') {
        const duration = now - this.activeFault!.startedAt;
        const factor = Math.min(duration / 40000, 1);
        if (Math.random() < 0.5) service = 'location';
        if (service === 'location') {
          latency_ms = Math.floor(Math.random() * 150) + 20 + (factor * 5000);
          if (latency_ms > 2000 && Math.random() < 0.2) status = 500;
        }
        if (Math.random() < 0.2) {
          this.emit({
            ts: new Date().toISOString(), stack_id: 'arena', service: 'location', kind: 'metric',
            payload: { metric_name: 'memory_usage_pct', value: 40 + (factor * 58) }
          });
        }
      }
      else if (faultType === 'surge_poison') {
        if (Math.random() < 0.5) service = 'payments';
        if (service === 'payments') {
          status = 500;
          latency_ms = Math.floor(Math.random() * 1000) + 500;
          if (Math.random() < 0.6) kind = 'error';
        }
      }
      else if (faultType === 'fare_corrupt') {
        const duration = now - this.activeFault!.startedAt;
        if (duration > 25000) {
          if (Math.random() < 0.8) service = 'payments';
          if (service === 'payments') {
            status = 500;
            if (Math.random() < 0.8) kind = 'error';
          }
        } else {
           // nothing visible for 25s
           status = 200;
           kind = 'request';
        }
      }
      else if (faultType === 'double_dispatch') {
         // no errors
      }

      let payload: any = {
        route: MESSAGES[Math.floor(Math.random() * MESSAGES.length)],
        status,
        latency_ms
      };

      if (kind === 'error') {
        payload = {
          message: service === 'postgres' ? 'FATAL: too many clients' : 'Connection reset by peer',
          stack_hint: 'at Object.invoke (source.ts:42)'
        };
      }

      this.emit({
        ts: new Date().toISOString(),
        stack_id: 'arena',
        service,
        trace_id: crypto.randomUUID().split('-')[0],
        kind,
        payload
      });
    }, 333));
    
    // World tick interval (1/sec)
    this.intervals.push(window.setInterval(() => {
      this.tick();
    }, 1000));
  }

  private emit(event: ArenaEvent) {
    this.listeners.forEach(l => l(event));
  }

  private tick() {
    this.tickCount++;
    const t = this.tickCount;
    const now = Date.now();
    
    if (t === 20 && !this.activeFault && !this.hasManualFault) {
        this.triggerFault('db_kill');
        this.hasManualFault = false; // preserve auto-trigger if they didn't click
    }
    
    let faultType: FaultType | undefined;
    let faultFactor = 0;
    if (this.activeFault && now <= this.activeFault.startedAt + this.activeFault.durationMs) {
      faultType = this.activeFault.fault;
      faultFactor = Math.min((now - this.activeFault.startedAt) / this.activeFault.durationMs, 1);
    }

    let surge = 1.0;
    if (faultType === 'db_kill') surge = 1 + faultFactor * 6;
    if (faultType === 'surge_poison') surge = 50.0;

    // Spawn riders
    const spawnRate = faultType === 'db_kill' ? 0.8 : faultType === 'bad_deploy' ? 0 : 0.3;
    if (Math.random() < spawnRate) {
      this.riders.push({
        id: `r${Math.floor(Math.random()*10000)}`,
        x: Math.random() * 80 + 10,
        y: Math.random() * 80 + 10,
        st: 'waiting',
        spawnTime: t,
        quote: faultType === 'surge_poison' ? Math.floor(Math.random() * 100) + 800 : Math.floor(Math.random() * 20) + 10,
        destX: Math.random() * 80 + 10,
        destY: Math.random() * 80 + 10
      });
    }

    // double_dispatch manual trigger
    if (faultType === 'double_dispatch' && !this.doubleDispatchFired && faultFactor > 0.1) {
       this.doubleDispatchFired = true;
       const idleD = this.drivers.find(d => d.st === 'idle');
       if (idleD) {
          const r1 = {
             id: `r${Math.floor(Math.random()*10000)}`, x: idleD.x - 20, y: idleD.y - 20, 
             st: 'matched', spawnTime: t, quote: 15, destX: 50, destY: 50, driverId: idleD.id
          };
          const r2 = {
             id: `r${Math.floor(Math.random()*10000)}`, x: idleD.x + 20, y: idleD.y + 20, 
             st: 'matched', spawnTime: t, quote: 15, destX: 50, destY: 50, driverId: idleD.id
          };
          this.riders.push(r1, r2);
          idleD.st = 'enroute';
          idleD.targetX = r1.x;
          idleD.targetY = r1.y;
          
          this.emit({
             ts: new Date().toISOString(), stack_id: 'arena', service: 'matching', kind: 'invariant_breach',
             payload: { invariant: 'driver_single_trip', detail: `${idleD.id} active_trips=2` }
          });
       }
    }
    
    // Update logic
    for (const r of this.riders) {
       if (r.st === 'waiting') {
           if (faultType === 'db_kill' && (t - r.spawnTime > 5)) {
               r.st = 'stranded';
           } else if (faultType !== 'db_kill') {
               const idleD = this.drivers.find(d => d.st === 'idle');
               if (idleD) {
                   r.st = 'matched';
                   r.driverId = idleD.id;
                   idleD.st = 'enroute';
                   idleD.targetX = r.x;
                   idleD.targetY = r.y;
                   idleD.riderId = r.id;
                   r.eta_s = Math.floor(Math.hypot(idleD.x - r.x, idleD.y - r.y) / 5);
               }
           }
       }
    }
    
    for (const d of this.drivers) {
       // Check mem_leak freeze
       if (faultType === 'mem_leak' && Math.random() < faultFactor) {
          continue; // stutter
       }

       if (d.st === 'enroute') {
           const dx = d.targetX - d.x;
           const dy = d.targetY - d.y;
           if (dx !== 0 || dy !== 0) d.heading = Math.atan2(dy, dx) * (180 / Math.PI);
           
           d.x = moveTowards(d.x, d.targetX, 5);
           d.y = moveTowards(d.y, d.targetY, 5);
           const r = this.riders.find(ri => ri.id === d.riderId);
           if (r) {
             r.eta_s = Math.floor(Math.hypot(d.x - r.x, d.y - r.y) / 5);
           }
           if (Math.abs(d.x - d.targetX) < 1 && Math.abs(d.y - d.targetY) < 1) {
               d.st = 'ontrip';
               if (r) {
                 r.st = 'riding';
                 d.targetX = r.destX;
                 d.targetY = r.destY;
               }
           }
       } else if (d.st === 'ontrip') {
           const dx = d.targetX - d.x;
           const dy = d.targetY - d.y;
           if (dx !== 0 || dy !== 0) d.heading = Math.atan2(dy, dx) * (180 / Math.PI);
           
           d.x = moveTowards(d.x, d.targetX, 5);
           d.y = moveTowards(d.y, d.targetY, 5);
           const r = this.riders.find(ri => ri.id === d.riderId);
           if (r) {
             r.x = d.x;
             r.y = d.y;
           }
           if (Math.abs(d.x - d.targetX) < 1 && Math.abs(d.y - d.targetY) < 1) {
               d.st = 'idle';
               this.riders = this.riders.filter(ri => ri.id !== d.riderId);
               delete d.riderId;
           }
       } else if (d.st === 'idle') {
           const targetX = d.x + (Math.random() - 0.5) * 10;
           const targetY = d.y + (Math.random() - 0.5) * 10;
           const dx = targetX - d.x;
           const dy = targetY - d.y;
           if (dx !== 0 || dy !== 0) d.heading = Math.atan2(dy, dx) * (180 / Math.PI);
           
           d.x = moveTowards(d.x, targetX, 2);
           d.y = moveTowards(d.y, targetY, 2);
           d.x = Math.max(0, Math.min(100, d.x));
           d.y = Math.max(0, Math.min(100, d.y));
       }
    }
    
    if (faultType !== 'db_kill') {
       this.riders = this.riders.filter(r => r.st !== 'stranded' || Math.random() > 0.1);
    }
    
    this.emit({
      ts: new Date().toISOString(),
      stack_id: 'arena',
      service: 'world',
      kind: 'world_tick',
      payload: {
        tick: t,
        surge: Number(surge.toFixed(1)),
        drivers: JSON.parse(JSON.stringify(this.drivers)),
        riders: JSON.parse(JSON.stringify(this.riders)),
      } as WorldTickPayload
    });
  }

  triggerInvestigation() {
    let step = 0;
    
    // Stop any existing script
    if ((this as any).investigationTimer) {
       clearTimeout((this as any).investigationTimer);
    }
    
    const runStep = () => {
      const ts = new Date().toISOString();
      const stack_id = 'arena';
      
      switch(step) {
        case 0:
          // 1. Slice Ready
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'slice_ready',
            payload: {
              slice: {
                nodes: [
                  { id: 'n1', label: 'payments/capture.py:130', role: 'manifestation' },
                  { id: 'n2', label: 'trips/calculate.py:45', role: 'candidate' },
                  { id: 'n3', label: 'pricing/rates.py:88', role: 'candidate' }
                ],
                edges: [
                  { from: 'n3', to: 'n2' },
                  { from: 'n2', to: 'n1' }
                ]
              }
            }
          } as any);
          break;
        case 1:
          // 2. Probes Armed on n1 and n2
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'probes_armed',
            payload: {
              node_ids: ['n1', 'n2']
            }
          } as any);
          break;
        case 2:
          // 3. Snapshot on n1
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'snapshot',
            payload: {
              node_id: 'n1',
              trace_id: 'tr_9901',
              expr: 'fare_amount',
              value: '"842.00"',
              population: 'failing'
            }
          } as any);
          break;
        case 3:
          // 4. Exonerate n2
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'exonerated',
            payload: {
              node_ids: ['n2'],
              reason: 'Calculations verified: formula correct'
            }
          } as any);
          break;
        case 4:
          // 5. Probes Armed on n3
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'probes_armed',
            payload: {
              node_ids: ['n3']
            }
          } as any);
          break;
        case 5:
          // 6. Snapshot on n3
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'snapshot',
            payload: {
              node_id: 'n3',
              trace_id: 'tr_9901',
              expr: 'raw_fare_multiplier',
              value: '"2,45"',
              population: 'failing'
            }
          } as any);
          break;
        case 6:
          // 7. Origin Found
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'origin_found',
            payload: {
              origin: 'pricing/rates.py:88',
              chain: ['n3', 'n2', 'n1'],
              confidence: 'high'
            }
          } as any);
          break;
        case 7:
          // 8. Fix Proposed (PR card)
          this.emit({
            ts, stack_id, service: 'origin_tracing',
            kind: 'fix_proposed',
            payload: {
              title: 'Fix comma-decimal locale issue in rate parsing',
              diff_summary: '--- pricing/rates.py\n+++ pricing/rates.py\n- multiplier = float(raw_multiplier)\n+ multiplier = float(raw_multiplier.replace(\',\', \'.\'))',
              witnessed: 'pricing/rates.py:88',
              pr_url: 'https://github.com/riderush/pricing/pull/482'
            }
          } as any);
          break;
      }
      
      step++;
      if (step <= 7) {
        (this as any).investigationTimer = setTimeout(runStep, 2000);
      }
    };
    
    (this as any).investigationTimer = setTimeout(runStep, 500);
  }

  stop() {
    this.intervals.forEach(window.clearInterval);
    this.intervals = [];
  }

  subscribe(listener: (event: ArenaEvent) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}

import { liveDataSource } from './LiveDataSource';
import { StackId } from '../types';

export const DATA_SOURCE: 'mock' | 'live' = 'live';
const mockDataSourceInstance = new MockDataSourceImpl();

class DataSourceFacade {
  start() {
    if (DATA_SOURCE === 'live') {
      liveDataSource.start();
    } else {
      mockDataSourceInstance.start();
    }
  }

  stop() {
    if (DATA_SOURCE === 'live') {
      liveDataSource.stop();
    } else {
      mockDataSourceInstance.stop();
    }
  }

  subscribe(listener: (event: ArenaEvent) => void, stackId?: StackId) {
    if (DATA_SOURCE === 'live') {
      return liveDataSource.subscribe(listener, stackId);
    } else {
      return mockDataSourceInstance.subscribe(listener);
    }
  }

  triggerFault(fault: FaultType) {
    if (DATA_SOURCE === 'live') {
      liveDataSource.triggerFault(fault);
    } else {
      mockDataSourceInstance.triggerFault(fault);
    }
  }

  triggerInvestigation() {
    // Both allow triggering investigation (plays sequence)
    mockDataSourceInstance.triggerInvestigation();
  }

  get liveInstance() {
    return liveDataSource;
  }

  get mockInstance() {
    return mockDataSourceInstance;
  }
}

export const mockDataSource = new DataSourceFacade();

