import React, { useEffect, useState, useRef } from 'react';
import { mockDataSource } from '../lib/MockDataSource';
import { ArenaEvent, RequestPayload } from '../types';
import { Network } from 'lucide-react';

const NODES = [
  { id: 'gateway', label: 'gateway', x: 400, y: 120, type: 'service' },
  { id: 'matching', label: 'matching', x: 200, y: 260, type: 'service' },
  { id: 'pricing', label: 'pricing', x: 400, y: 260, type: 'service' },
  { id: 'trips', label: 'trips', x: 600, y: 260, type: 'service' },
  { id: 'location', label: 'location', x: 200, y: 400, type: 'service' },
  { id: 'payments', label: 'payments', x: 600, y: 400, type: 'service' },
  { id: 'redis', label: 'redis', x: 200, y: 540, type: 'database' },
  { id: 'postgres', label: 'postgres', x: 500, y: 540, type: 'database' },
];

const EDGES = [
  { from: 'gateway', to: 'matching' },
  { from: 'gateway', to: 'pricing' },
  { from: 'gateway', to: 'trips' },
  { from: 'matching', to: 'location' },
  { from: 'trips', to: 'payments' },
  { from: 'matching', to: 'postgres' },
  { from: 'pricing', to: 'postgres' },
  { from: 'trips', to: 'postgres' },
  { from: 'payments', to: 'postgres' },
  { from: 'location', to: 'redis' }
];

type NodeHealth = 'healthy' | 'degraded' | 'failing';

interface NodeStats {
  health: NodeHealth;
  avgLatency: number;
  cascading?: boolean;
}

interface Particle {
  id: string;
  edge: { from: string; to: string };
  progress: number;
  isError: boolean;
  speed: number;
}

function ParticlesLayer({ activeParticles }: { activeParticles: React.MutableRefObject<Particle[]> }) {
  const [, setTick] = useState(0);
  
  useEffect(() => {
    let frame: number;
    const loop = () => {
      activeParticles.current.forEach(p => {
        p.progress += p.speed;
      });
      activeParticles.current = activeParticles.current.filter(p => p.progress <= 1);
      setTick(t => t + 1);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [activeParticles]);
  
  return (
    <g>
      {activeParticles.current.map(p => {
        let startX, startY, endX, endY;
        if (p.edge.from === 'internet') {
          const toNode = NODES.find(n => n.id === p.edge.to)!;
          startX = toNode.x;
          startY = toNode.y - 80;
          endX = toNode.x;
          endY = toNode.y;
        } else {
          const fromNode = NODES.find(n => n.id === p.edge.from)!;
          const toNode = NODES.find(n => n.id === p.edge.to)!;
          startX = fromNode.x;
          startY = fromNode.y;
          endX = toNode.x;
          endY = toNode.y;
        }
        
        const cx = startX + (endX - startX) * p.progress;
        const cy = startY + (endY - startY) * p.progress;
        const color = p.isError ? "var(--color-status-failing)" : "var(--color-status-healthy)";
        return (
          <circle
            key={p.id}
            cx={cx}
            cy={cy}
            r={5}
            fill={color}
            filter={`drop-shadow(0 0 6px ${color})`}
          />
        );
      })}
    </g>
  );
}

export default function DependencyGraph() {
  const [nodeStats, setNodeStats] = useState<Record<string, NodeStats>>({});
  const [locationMemory, setLocationMemory] = useState<number | null>(null);
  
  const eventHistory = useRef<{ [nodeId: string]: { ts: number, latency?: number, isError: boolean }[] }>({});
  const activeParticles = useRef<Particle[]>([]);

  useEffect(() => {
    const unsubscribe = mockDataSource.subscribe((ev: ArenaEvent) => {
      if (ev.kind === 'metric') {
        const payload = ev.payload as any;
        if (payload.metric_name === 'memory_usage_pct' && ev.service === 'location') {
          setLocationMemory(payload.value);
        }
        return;
      }
      
      if (ev.kind === 'fault_cleared') {
         const payload = ev.payload as any;
         if (payload.fault === 'mem_leak') {
            setLocationMemory(null);
         }
         return;
      }

      if (ev.kind === 'world_tick' || ev.kind === 'fault_started') {
        return;
      }
      
      const now = Date.now();
      if (!eventHistory.current[ev.service]) {
        eventHistory.current[ev.service] = [];
      }
      
      let latency: number | undefined = undefined;
      let isError = false;
      if (ev.kind === 'error') {
        isError = true;
      } else if (ev.kind === 'request') {
        const payload = ev.payload as RequestPayload;
        latency = payload.latency_ms;
        isError = payload.status >= 500;
      } else {
        return;
      }
      
      eventHistory.current[ev.service].push({ ts: now, latency, isError });

      // Spawn particle
      const incomingEdges = EDGES.filter(e => e.to === ev.service);
      let edge = null;
      if (incomingEdges.length > 0) {
        edge = incomingEdges[Math.floor(Math.random() * incomingEdges.length)];
      } else if (ev.service === 'gateway') {
        edge = { from: 'internet', to: 'gateway' };
      }

      if (edge) {
        activeParticles.current.push({
          id: crypto.randomUUID(),
          edge,
          progress: 0,
          isError,
          speed: 0.015 + Math.random() * 0.01
        });
      }
    });

    const interval = setInterval(() => {
      const now = Date.now();
      const newStats: Record<string, NodeStats> = {};
      
      NODES.forEach(n => {
        const history = eventHistory.current[n.id] || [];
        const recent = history.filter(h => now - h.ts <= 10000);
        eventHistory.current[n.id] = recent;
        
        let errorCount = 0;
        let latencySum = 0;
        let latencyCount = 0;
        
        recent.forEach(h => {
          if (h.isError) errorCount++;
          if (h.latency !== undefined) {
            latencySum += h.latency;
            latencyCount++;
          }
        });
        
        const avgLatency = latencyCount > 0 ? latencySum / latencyCount : 0;
        const errorRate = recent.length > 0 ? errorCount / recent.length : 0;
        
        let health: NodeHealth = 'healthy';
        if (errorRate > 0.2) health = 'failing';
        else if (avgLatency > 500) health = 'degraded';
        
        newStats[n.id] = { health, avgLatency };
      });
      
      const gatewayDownstreamFailing = ['matching', 'pricing', 'trips'].some(id => newStats[id]?.health === 'failing');
      if (gatewayDownstreamFailing && newStats['gateway']) {
        newStats['gateway'].cascading = true;
      }
      
      setNodeStats(newStats);
    }, 250);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="h-full w-full bg-[#0B0E14] border-r border-[#1E2530] relative flex flex-col overflow-hidden">
      <div className="absolute top-4 left-4 z-10 flex gap-2">
        <Network className="w-4 h-4 text-slate-500" />
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Dependency Graph</span>
      </div>
      
      <div className="flex-1 w-full relative">
        <svg viewBox="100 60 600 560" className="w-full h-full p-8 drop-shadow-lg">
          <g>
            {EDGES.map(e => {
              const from = NODES.find(n => n.id === e.from)!;
              const to = NODES.find(n => n.id === e.to)!;
              return (
                <line key={`${e.from}-${e.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.25)" strokeWidth="2.5" />
              );
            })}
          </g>
          
          <ParticlesLayer activeParticles={activeParticles} />

          {NODES.map(node => {
            const stats = nodeStats[node.id];
            const isCylinder = node.type === 'database';
            const width = 100;
            const height = 50;
            const cx = node.x;
            const cy = node.y;
            
            const healthColor = stats?.health === 'failing' ? 'var(--color-status-failing)' : 
                                stats?.health === 'degraded' ? 'var(--color-status-degraded)' : 
                                '#1E2530';
                                
            const cascadeTint = stats?.cascading ? 'var(--color-status-failing)' : 'transparent';
          
            return (
              <g key={node.id} transform={`translate(${cx}, ${cy})`}>
                {stats?.health === 'failing' && (
                  <circle cx="0" cy="0" r={width/1.2} fill="var(--color-status-failing)" opacity="0.15" className="animate-pulse" />
                )}
                
                {isCylinder ? (
                  <g transform={`translate(${-width/2}, ${-height/2})`}>
                    <path d={`M 0 10 L 0 ${height-10} A ${width/2} 12 0 0 0 ${width} ${height-10} L ${width} 10 Z`} fill="#12161F" stroke={healthColor} strokeWidth="2.5" style={{ filter: stats?.cascading ? `drop-shadow(0 0 10px ${cascadeTint})` : 'none' }} />
                    <ellipse cx={width/2} cy="10" rx={width/2} ry="12" fill="#1A2130" stroke={healthColor} strokeWidth="2.5" />
                  </g>
                ) : (
                  <g>
                    <rect x={-width/2} y={-height/2} width={width} height={height} rx="8" fill="#12161F" stroke={healthColor} strokeWidth="2.5" style={{ filter: stats?.cascading ? `drop-shadow(0 0 10px ${cascadeTint})` : 'none' }} />
                    {stats?.cascading && <rect x={-width/2} y={-height/2} width={width} height={height} rx="8" fill="var(--color-status-failing)" opacity="0.1" pointerEvents="none" />}
                  </g>
                )}
                
                <text x="0" y={isCylinder ? -2 : -4} textAnchor="middle" fill="#E2E8F0" fontSize="12" className="font-mono tracking-wide">
                  {node.label}
                </text>
                
                {stats && stats.avgLatency > 0 && (
                  <text x="0" y={isCylinder ? 16 : 14} textAnchor="middle" fill={stats.health === 'failing' ? "var(--color-status-failing)" : "var(--color-slate-400)"} fontSize="11" className="font-mono">
                    {stats.avgLatency.toFixed(0)}ms
                  </text>
                )}

                {node.id === 'location' && locationMemory !== null && (
                  <g transform={`translate(${-width/2}, ${height/2 + 8})`}>
                     <rect x="0" y="0" width={width} height="4" fill="var(--color-bg-base)" rx="2" />
                     <rect x="0" y="0" width={width * (locationMemory / 100)} height="4" fill="var(--color-status-failing)" rx="2" className="transition-all duration-300 ease-out" />
                     <text x={width/2} y="15" textAnchor="middle" fill="var(--color-status-failing)" fontSize="10" fontFamily="monospace" className="font-bold animate-pulse">
                        MEM {locationMemory.toFixed(0)}%
                     </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
