import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { mockDataSource } from '../lib/MockDataSource';
import { WorldTickPayload, StackId } from '../types';
import { Users } from 'lucide-react';

type TrackedDriver = {
  id: string;
  st: 'idle' | 'enroute' | 'ontrip';
  prev: { x: number, y: number, ts: number };
  curr: { x: number, y: number, ts: number };
  ix: number;
  iy: number;
  duration: number;
  history: { x: number, y: number }[];
  isDoubleDispatched: boolean;
};

type MatchLine = {
  riderId: string;
  driverId: string;
  rx: number;
  ry: number;
  matchedAt: number;
};

function getDriverColor(st: string) {
    if (st === 'idle') return '#22C55E';
    if (st === 'enroute') return '#7C6FFF';
    if (st === 'ontrip') return '#3B82F6';
    return '#22C55E';
}

function getRiderColor(st: string) {
    if (st === 'stranded') return '#EF4444';
    if (st === 'matched') return '#22C55E';
    if (st === 'riding') return '#7C6FFF';
    return '#E2E8F0';
}

export default function CityMap({ stackId = 'arena', compact = false }: { stackId?: StackId, compact?: boolean }) {
  const [worldState, setWorldState] = useState<WorldTickPayload | null>(null);
  const tracked = useRef<{ [id: string]: TrackedDriver }>({});
  const lines = useRef<MatchLine[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const rAFRef = useRef<number | null>(null);

  useEffect(() => {
    mockDataSource.start();
    const unsubscribe = mockDataSource.subscribe((event) => {
      if (event.kind === 'world_tick') {
        const payload = event.payload as WorldTickPayload;
        setWorldState(payload);
        const now = Date.now();

        for (const d of payload.drivers) {
          const existing = tracked.current[d.id];
          if (!existing) {
            tracked.current[d.id] = {
              id: d.id, st: d.st,
              prev: { x: d.x, y: d.y, ts: now },
              curr: { x: d.x, y: d.y, ts: now },
              ix: d.x, iy: d.y,
              duration: 1000,
              history: [],
              isDoubleDispatched: false
            };
          } else {
            const timeSinceLast = now - existing.curr.ts;
            existing.st = d.st;
            existing.prev = { x: existing.ix, y: existing.iy, ts: now };
            existing.curr = { x: d.x, y: d.y, ts: now };
            existing.duration = timeSinceLast > 1200 ? 300 : 1000;
          }
        }

        for (const r of payload.riders) {
          if (r.st === 'matched' && r.driverId) {
            if (!lines.current.some(l => l.riderId === r.id)) {
              lines.current.push({
                riderId: r.id,
                driverId: r.driverId,
                rx: r.x, ry: r.y,
                matchedAt: now
              });
            }
          }
        }
      }
    });

    const loop = () => {
      const now = Date.now();
      
      for (const d of Object.values(tracked.current) as TrackedDriver[]) {
        const dt = now - d.curr.ts;
        const progress = Math.min(1, Math.max(0, dt / d.duration));
        
        if (progress === 1) {
          d.ix = d.curr.x;
          d.iy = d.curr.y;
        } else {
          const dx = d.curr.x - d.prev.x;
          const dy = d.curr.y - d.prev.y;
          const ease = d.duration === 300 ? (t: number) => t * (2 - t) : (t: number) => t; 
          const p = ease(progress);

          const totalDist = Math.abs(dx) + Math.abs(dy);
          if (totalDist > 0.01) {
              const pX = Math.abs(dx) / totalDist;
              if (Math.abs(dx) > Math.abs(dy)) {
                  if (p <= pX) {
                      d.ix = d.prev.x + dx * (p / (pX || 1));
                      d.iy = d.prev.y;
                  } else {
                      d.ix = d.curr.x;
                      d.iy = d.prev.y + dy * ((p - pX) / (1 - pX || 1));
                  }
              } else {
                  const pY = Math.abs(dy) / totalDist;
                  if (p <= pY) {
                      d.ix = d.prev.x;
                      d.iy = d.prev.y + dy * (p / (pY || 1));
                  } else {
                      d.ix = d.prev.x + dx * ((p - pY) / (1 - pY || 1));
                      d.iy = d.curr.y;
                  }
              }
          } else {
              d.ix = d.curr.x;
              d.iy = d.curr.y;
          }
        }

        const lastPt = d.history[0];
        if (!lastPt || Math.hypot(lastPt.x - d.ix, lastPt.y - d.iy) > 1.5) {
            d.history.unshift({ x: d.ix, y: d.iy });
            if (d.history.length > 3) d.history.pop();
        }

        if (svgRef.current) {
          const g = svgRef.current.querySelector(`#driver-${d.id}`);
          if (g) g.setAttribute('transform', `translate(${d.ix}, ${d.iy})`);
          
          for (let i = 0; i < 3; i++) {
            const tail = svgRef.current.querySelector(`#driver-${d.id}-tail-${i}`);
            if (tail) {
              const pt = d.history[i];
              if (pt) {
                tail.setAttribute('cx', String(pt.x));
                tail.setAttribute('cy', String(pt.y));
                tail.setAttribute('opacity', String(0.6 - i * 0.2));
              } else {
                tail.setAttribute('opacity', '0');
              }
            }
          }
        }
      }

      if (svgRef.current) {
        const matchLinesGroup = svgRef.current.querySelector('#match-lines');
        if (matchLinesGroup) {
          for (let i = lines.current.length - 1; i >= 0; i--) {
            const line = lines.current[i];
            const age = now - line.matchedAt;
            if (age > 2200) {
              lines.current.splice(i, 1);
              continue;
            }
            
            const driver = tracked.current[line.driverId];
            if (driver) {
              let el = matchLinesGroup.querySelector(`#matchline-${line.riderId}`);
              if (!el) {
                el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                el.setAttribute('id', `matchline-${line.riderId}`);
                el.setAttribute('stroke', '#22C55E');
                el.setAttribute('stroke-width', '0.5');
                el.setAttribute('stroke-dasharray', '1 1.5');
                el.setAttribute('x1', String(line.rx));
                el.setAttribute('y1', String(line.ry));
                matchLinesGroup.appendChild(el);
              }
              
              let currentX2 = driver.ix;
              let currentY2 = driver.iy;
              
              if (age < 400) {
                  const progress = age / 400;
                  currentX2 = line.rx + (driver.ix - line.rx) * progress;
                  currentY2 = line.ry + (driver.iy - line.ry) * progress;
                  el.setAttribute('opacity', '1');
              } else if (age < 1900) {
                  el.setAttribute('opacity', '1');
              } else {
                  el.setAttribute('opacity', String(1 - ((age - 1900) / 300)));
              }
              
              el.setAttribute('x2', String(currentX2));
              el.setAttribute('y2', String(currentY2));
            }
          }
          
          const childNodes = Array.from(matchLinesGroup.childNodes);
          for (const child of childNodes) {
              const id = (child as SVGElement).id;
              if (id && !lines.current.some(l => `matchline-${l.riderId}` === id)) {
                  matchLinesGroup.removeChild(child);
              }
          }
        }
      }

      rAFRef.current = requestAnimationFrame(loop);
    };

    rAFRef.current = requestAnimationFrame(loop);

    return () => {
      unsubscribe();
      if (rAFRef.current) cancelAnimationFrame(rAFRef.current);
    };
  }, [stackId]);

  if (!worldState) {
    return (
      <div className="h-full w-full bg-[#0B0E14] border-r border-[#1E2530] flex items-center justify-center">
        <span className="text-sm font-mono font-bold tracking-widest text-slate-500 animate-pulse uppercase">Syncing World State...</span>
      </div>
    );
  }

  const strandedCount = worldState.riders.filter(r => r.st === 'stranded').length;
  const isHighSurge = worldState.surge > 2.0;
  const isExtremeSurge = worldState.surge > 5.0;

  return (
    <div className="h-full w-full bg-[#0B0E14] border-r border-[#1E2530] relative overflow-hidden flex items-center justify-center">
      
      {/* Vignette for high stranded count on B */}
      {stackId === 'gauntlet_b' && strandedCount >= 25 && (
        <div className="absolute inset-0 pointer-events-none border-[12px] border-status-failing/20 shadow-[inset_0_0_50px_rgba(239,68,68,0.4)] animate-pulse z-40" />
      )}

      {/* Overlays */}
      {!compact && (
        <div className="absolute top-4 left-4 z-10 flex flex-col gap-2 pointer-events-none">
          <div className={`px-2 py-1 rounded border flex items-center gap-2 shadow-sm font-mono ${
            strandedCount > 0 
              ? 'bg-[#EF4444]/10 border-[#EF4444]/30 text-[#EF4444]' 
              : 'bg-[#12161F] border-[#1E2530] text-slate-400'
          }`}>
            <Users className="w-3 h-3" />
            <span className="text-[10px] font-bold tracking-wider">STRANDED: {strandedCount}</span>
          </div>

          <div className={`px-2 py-1 rounded border flex items-center gap-2 shadow-sm font-mono ${
            isExtremeSurge ? 'bg-[#EF4444]/10 border-[#EF4444]/30 text-[#EF4444]' :
            isHighSurge ? 'bg-[#F59E0B]/10 border-[#F59E0B]/30 text-[#F59E0B]' :
            'bg-[#12161F] border-[#1E2530] text-slate-400'
          }`}>
            <span className={`font-bold tracking-wider ${isExtremeSurge ? 'text-sm' : 'text-[10px]'}`}>
              SURGE: {worldState.surge.toFixed(1)}X
            </span>
          </div>
        </div>
      )}

      {/* SVG Canvas Map */}
      <svg 
        ref={svgRef}
        viewBox="0 0 100 100" 
        className="w-full h-full p-4"
        style={{ filter: 'drop-shadow(0 0 20px rgba(0,0,0,0.5))' }}
      >
        {/* Decorative Map Background */}
        <g opacity="0.6">
          {Array.from({ length: 21 }).map((_, i) => (
            <React.Fragment key={i}>
              <line x1={i * 5} y1="0" x2={i * 5} y2="100" stroke="#1A2130" strokeWidth="0.2" />
              <line x1="0" y1={i * 5} x2="100" y2={i * 5} stroke="#1A2130" strokeWidth="0.2" />
            </React.Fragment>
          ))}
          <line x1="25" y1="0" x2="25" y2="100" stroke="#1A2130" strokeWidth="0.8" />
          <line x1="50" y1="0" x2="50" y2="100" stroke="#1A2130" strokeWidth="0.8" />
          <line x1="75" y1="0" x2="75" y2="100" stroke="#1A2130" strokeWidth="0.8" />
          <line x1="0" y1="25" x2="100" y2="25" stroke="#1A2130" strokeWidth="0.8" />
          <line x1="0" y1="50" x2="100" y2="50" stroke="#1A2130" strokeWidth="0.8" />
          <line x1="0" y1="75" x2="100" y2="75" stroke="#1A2130" strokeWidth="0.8" />
          
          <rect x="10" y="10" width="10" height="10" fill="#12161F" rx="0.5" />
          <rect x="30" y="60" width="15" height="10" fill="#12161F" rx="0.5" />
          <rect x="60" y="30" width="10" height="15" fill="#12161F" rx="0.5" />
        </g>

        {/* Dynamic Layers */}
        <g id="match-lines"></g>
        
        <g id="driver-tails">
           {worldState.drivers.map(d => (
             <g key={d.id}>
               {[0, 1, 2].map(i => <circle key={i} id={`driver-${d.id}-tail-${i}`} r="0.6" fill={getDriverColor(d.st)} opacity="0" />)}
             </g>
           ))}
        </g>

        <g id="drivers">
          {worldState.drivers.map(driver => {
            const isDoubleDispatched = worldState.riders.filter(r => (r.st === 'matched' || r.st === 'riding') && r.driverId === driver.id).length > 1;
            return (
              <g key={driver.id} id={`driver-${driver.id}`}>
                <circle cx="0" cy="0" r="1.5" fill={isDoubleDispatched ? '#EF4444' : getDriverColor(driver.st)} opacity="0.2" className={isDoubleDispatched ? "animate-pulse" : ""} />
                <circle cx="0" cy="0" r="0.5" fill={isDoubleDispatched ? '#EF4444' : getDriverColor(driver.st)} />
                {isDoubleDispatched && (
                  <g transform="translate(0, -3) rotate(-90)">
                    <polygon points="0,-1.5 1.5,1.5 -1.5,1.5" fill="#EF4444" className="animate-ping" />
                    <polygon points="0,-1.5 1.5,1.5 -1.5,1.5" fill="#EF4444" />
                  </g>
                )}
              </g>
            );
          })}
        </g>

        <g id="riders">
          <AnimatePresence>
            {worldState.riders.map(rider => (
              <motion.g
                key={rider.id}
                initial={{ scale: 0, x: rider.x, y: rider.y }}
                animate={{ scale: 1, x: rider.x, y: rider.y }}
                exit={{ scale: 0 }}
                transition={{ duration: 0.2 }}
                className="group cursor-pointer"
              >
                <circle cx="0" cy="0" r="3" fill="transparent" />
                <motion.circle
                  cx="0" cy="0" r="1.2"
                  fill={getRiderColor(rider.st)}
                  animate={rider.st === 'stranded' ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
                  transition={rider.st === 'stranded' ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
                />
                
                {(rider.quote || rider.eta_s !== undefined) && (
                  <g className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                    <rect x="2" y="-6" width="24" height="10" fill="#12161F" rx="1" stroke="#1E2530" strokeWidth="0.4"/>
                    {rider.quote && (
                      <text x="4" y="-2" fontSize="2.5" fill="#E2E8F0" className="font-mono font-bold">
                        {rider.quote}
                      </text>
                    )}
                    {rider.eta_s !== undefined && (
                      <text x="4" y="2" fontSize="2.5" fill="#F59E0B" className="font-mono">
                        ETA {Math.floor(rider.eta_s / 60)}:{(rider.eta_s % 60).toString().padStart(2, '0')}
                      </text>
                    )}
                  </g>
                )}
              </motion.g>
            ))}
          </AnimatePresence>
        </g>
      </svg>
    </div>
  );
}
