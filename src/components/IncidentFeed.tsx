import React, { useEffect, useState, useRef } from 'react';
import { mockDataSource } from '../lib/MockDataSource';
import { ArenaEvent, FaultType, StackId } from '../types';

type FeedItem = 
  | { type: 'raw', id: string, event: ArenaEvent }
  | { type: 'incident', id: string, fault: string, startTime: number, endTime?: number, status: 'active'|'working'|'resolved', events: ArenaEvent[] };

const IncidentCard: React.FC<{ incident: any, getRecentEvents: () => ArenaEvent[] }> = ({ incident, getRecentEvents }) => {
   const [now, setNow] = useState(Date.now());
   const [narration, setNarration] = useState<string | null>(null);
   const lastNarratedStatus = useRef<string | null>(null);

   useEffect(() => {
      if (incident.status === 'resolved') return;
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
   }, [incident.status]);

   useEffect(() => {
      if (lastNarratedStatus.current !== incident.status) {
         lastNarratedStatus.current = incident.status;
         let isMounted = true;
         
         const recent = getRecentEvents().slice(-15);
         
         fetch('/api/narrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: recent, incidentState: incident.status })
         })
         .then(res => res.json())
         .then(data => {
            if (isMounted && data.text) setNarration(data.text);
         })
         .catch(() => {
            if (isMounted) setNarration("System stability degrading, chaos faults injected.");
         });
         
         return () => { isMounted = false; };
      }
   }, [incident.status, getRecentEvents]);
   
   const elapsed = incident.endTime ? (incident.endTime - incident.startTime) : (now - incident.startTime);
   const elapsedSec = Math.floor(Math.max(0, elapsed) / 1000);
   
   const railColor = incident.status === 'active' ? 'bg-status-failing' : 
                     incident.status === 'working' ? 'bg-status-agent' : 'bg-status-healthy';
                     
   return (
      <div className="flex bg-[#12161F] border border-[#1E2530] rounded-md overflow-hidden my-2 shadow-sm font-sans transition-all duration-200 ease-out hover:border-slate-700">
         <div className={`w-1.5 shrink-0 transition-colors duration-200 ease-out ${railColor}`} />
         <div className="p-3 flex-1 flex flex-col gap-2 min-w-0">
            <div className="flex justify-between items-center">
               <div className="font-bold text-slate-200 text-xs uppercase tracking-wider truncate">
                  INCIDENT: {incident.fault}
               </div>
               <div className="font-mono text-xs text-slate-400 shrink-0">
                  T+{elapsedSec}s
               </div>
            </div>
            {narration && (
               <div className="bg-bg-base p-2 rounded border border-border-subtle text-slate-300 text-xs italic">
                  "{narration}"
               </div>
            )}
            <div className="flex flex-col gap-1.5 text-[11px]">
               {incident.events.map((ev: ArenaEvent, i: number) => {
                   if (ev.kind === 'invariant_breach') {
                       const p = ev.payload as any;
                       return <div key={i} className="text-status-failing font-bold break-words">{p.invariant}: {p.detail}</div>
                   } else if (ev.kind === 'agent_action') {
                       const p = ev.payload as any;
                       return <div key={i} className="text-status-agent break-words flex gap-2">
                         <span className="shrink-0">🤖</span> <span>{p.message}</span>
                       </div>
                   } else if (ev.kind === 'fault_started') {
                       return <div key={i} className="text-slate-400 break-words">Fault injected across grid.</div>
                   } else if (ev.kind === 'fault_cleared') {
                       return <div key={i} className="text-status-healthy font-bold break-words">System recovered.</div>
                   }
                   return null;
               })}
            </div>
         </div>
      </div>
   );
};

export default function IncidentFeed({ stackId = 'arena', compact = false }: { stackId?: StackId, compact?: boolean }) {
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const rawEventsRef = useRef<ArenaEvent[]>([]);
  
  const [askQuery, setAskQuery] = useState("");
  const [askResponse, setAskResponse] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    mockDataSource.start();
    const unsubscribe = mockDataSource.subscribe((ev) => {
      rawEventsRef.current = [...rawEventsRef.current, ev].slice(-50);
      
      setFeedItems((prev) => {
        if (ev.kind === 'world_tick' || ev.kind === 'metric') return prev;
        let next = [...prev];
        
        if (ev.kind === 'fault_started') {
           next.push({ 
             type: 'incident', 
             id: ev.ts + Math.random(), 
             fault: (ev.payload as any).fault, 
             startTime: Date.now(), 
             status: 'active', 
             events: [ev] 
           });
        } else if (ev.kind === 'agent_action' || ev.kind === 'invariant_breach' || ev.kind === 'fault_cleared') {
           let activeIncIndex = -1;
           for (let i = next.length - 1; i >= 0; i--) {
             if (next[i].type === 'incident' && (next[i] as any).status !== 'resolved') {
               activeIncIndex = i;
               break;
             }
           }
           if (activeIncIndex >= 0) {
               const inc = { ...next[activeIncIndex] } as any;
               inc.events = [...inc.events, ev];
               if (ev.kind === 'agent_action') inc.status = 'working';
               if (ev.kind === 'fault_cleared') {
                   inc.status = 'resolved';
                   inc.endTime = Date.now();
               }
               next[activeIncIndex] = inc;
           } else {
               next.push({ type: 'raw', id: ev.ts + Math.random(), event: ev });
           }
        } else {
           next.push({ type: 'raw', id: ev.ts + Math.random(), event: ev });
        }
        
        if (next.length > 100) {
           next = next.slice(next.length - 100);
        }
        return next;
      });
    }, stackId);

    return () => {
      unsubscribe();
    };
  }, [stackId]);

  useEffect(() => {
    if (feedEndRef.current && !isHovered) {
      feedEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [feedItems, isHovered]);

  const handleAsk = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!askQuery.trim() || isAsking) return;
     
     const query = askQuery.trim();
     setAskQuery("");
     setIsAsking(true);
     setAskResponse("Thinking...");
     
     let activeFault: any = null;
     for (let i = feedItems.length - 1; i >= 0; i--) {
       if (feedItems[i].type === 'incident' && (feedItems[i] as any).status !== 'resolved') {
         activeFault = feedItems[i];
         break;
       }
     }
     
     try {
        const res = await fetch('/api/ask', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ 
              query, 
              events: rawEventsRef.current, 
              activeFault: activeFault ? activeFault.fault : null 
           })
        });
        const data = await res.json();
        setAskResponse(data.text);
        if (data.text === "Unable to process query at this time.") {
           setTimeout(() => {
              setAskResponse(prev => prev === "Unable to process query at this time." ? null : prev);
           }, 6000);
        }
     } catch (err) {
        setAskResponse("Unable to process query at this time.");
        setTimeout(() => {
           setAskResponse(prev => prev === "Unable to process query at this time." ? null : prev);
        }, 6000);
     } finally {
        setIsAsking(false);
     }
  };

  const getRecentEvents = () => rawEventsRef.current;

  return (
    <div className="flex-1 flex flex-col bg-bg-base overflow-hidden relative min-h-[300px]">
      <div className="p-4 border-b border-[#1E2530] bg-[#12161F] z-10 shrink-0">
        <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
          Incident Feed
        </h2>
      </div>
      <div 
        className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[10px] scrollbar-thin scrollbar-thumb-border-subtle scrollbar-track-transparent"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {feedItems.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 font-bold uppercase tracking-wider select-none text-[9px]">
            No live incidents recorded
          </div>
        ) : feedItems.map((item) => {
          if (item.type === 'incident') {
            return <IncidentCard key={item.id} incident={item} getRecentEvents={getRecentEvents} />;
          } else {
            const ev = item.event;
            const timeString = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false });
            
            let summary = "";
            const p = ev.payload as any;
            if (ev.kind === 'request') {
              summary = `${p.route || '?'} · ${p.status || '?'} · ${p.latency_ms || 0}ms`;
            } else if (ev.kind === 'error') {
              summary = p.message || "Error";
            } else if (ev.kind === 'agent_action') {
              summary = p.message || "";
            } else if (ev.kind === 'fault_started') {
              summary = p.fault ? `Fault injected: ${p.fault}` : "Fault injected";
            } else if (ev.kind === 'fault_cleared') {
              summary = "System recovered";
            } else if (ev.kind === 'invariant_breach') {
              summary = `${p.invariant}: ${p.detail}`;
            } else {
              summary = p.message || p.fault || "Event recorded";
            }
            
            return (
              <div key={item.id} className="flex gap-2 items-center transition-all duration-200 ease-out hover:bg-border-subtle/30 p-1 -mx-1 rounded text-slate-400 h-6 overflow-hidden">
                <span className="text-slate-600 shrink-0 font-mono">
                  [{timeString}]
                </span>
                <span className="text-status-origin font-bold shrink-0">[{ev.service}]</span>
                <span className="text-status-healthy font-bold shrink-0">{ev.kind}</span>
                <span className="text-slate-500 shrink-0">·</span>
                <span className="text-slate-300 truncate">
                  {summary}
                </span>
              </div>
            );
          }
        })}
        <div ref={feedEndRef} className="h-4 shrink-0" />
      </div>
      {!compact && (
        <div className="p-4 border-t border-[#1E2530] bg-[#12161F] z-10 shrink-0 flex flex-col gap-2">
           {askResponse && (
              <div className="bg-bg-base p-3 rounded border border-border-subtle text-slate-300 text-xs font-sans relative">
                 <button 
                    onClick={() => setAskResponse(null)} 
                    className="absolute top-2 right-2 text-slate-500 hover:text-slate-300"
                 >
                    ✕
                 </button>
                 <span className="font-bold text-status-agent mr-2">🤖</span>
                 {askResponse}
              </div>
           )}
           <form onSubmit={handleAsk} className="flex gap-2">
              <input 
                 type="text" 
                 value={askQuery}
                 onChange={(e) => setAskQuery(e.target.value)}
                 placeholder="Ask dispatch what's happening…" 
                 className="flex-1 bg-bg-base border border-border-subtle rounded-md px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-slate-500 font-sans"
                 disabled={isAsking}
              />
              <button 
                 type="submit" 
                 disabled={isAsking || !askQuery.trim()}
                 className="px-4 py-2 bg-border-subtle/50 hover:bg-border-subtle text-slate-300 rounded-md text-xs font-bold transition disabled:opacity-50 font-sans"
              >
                 ASK
              </button>
           </form>
        </div>
      )}
    </div>
  );
}
