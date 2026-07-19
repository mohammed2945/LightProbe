import React, { useState, useEffect } from 'react';
import { mockDataSource } from '../lib/MockDataSource';
import { FaultType, ArenaEvent } from '../types';

const CHAOS_ACTIONS: { icon: string, label: string, fault: FaultType }[] = [
  { icon: "💥", label: "Kill the Database", fault: 'db_kill' },
  { icon: "🚀", label: "Bad Deploy", fault: 'bad_deploy' },
  { icon: "🛰️", label: "Memory Leak", fault: 'mem_leak' },
  { icon: "📈", label: "Surge Poison", fault: 'surge_poison' },
  { icon: "🏷️", label: "Corrupt Fare Feed", fault: 'fare_corrupt' },
  { icon: "👥", label: "Double Dispatch", fault: 'double_dispatch' }
];

export default function ChaosPanel() {
  const [activeFault, setActiveFault] = useState<{ fault: FaultType, started: number, duration: number } | null>(null);
  const [confirming, setConfirming] = useState<FaultType | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const unsub = mockDataSource.subscribe((ev: ArenaEvent) => {
      if (ev.kind === 'fault_started' && 'fault' in ev.payload) {
        const payload = ev.payload as any;
        setActiveFault({ fault: payload.fault, started: Date.now(), duration: payload.durationMs || 45000 });
        setConfirming(null);
      } else if (ev.kind === 'fault_cleared') {
        setActiveFault(null);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    let timer: number;
    if (activeFault) {
      timer = window.setInterval(() => {
        const remaining = Math.max(0, activeFault.duration - (Date.now() - activeFault.started));
        setTimeLeft(remaining);
      }, 100);
    }
    return () => clearInterval(timer);
  }, [activeFault]);

  const handleAction = (fault: FaultType) => {
    if (activeFault) return;
    if (confirming === fault) {
      mockDataSource.triggerFault(fault);
    } else {
      setConfirming(fault);
      setTimeout(() => setConfirming(null), 3000);
    }
  };

  return (
    <div className="p-4 border-b border-[#1E2530] bg-[#12161F] shrink-0 relative">
      {activeFault && (
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-4 py-2 bg-status-failing border border-status-failing/50 text-white rounded shadow-lg text-sm font-bold animate-pulse z-50 whitespace-nowrap">
           💥 You broke the city. The AI is on it.
        </div>
      )}
      
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
          Chaos Controls
        </h2>
        {activeFault ? (
          <span className="px-2 py-0.5 bg-status-failing/20 text-status-failing rounded text-[10px] font-bold border border-status-failing/40 tracking-wider flex items-center gap-2">
             <svg className="w-3 h-3 -rotate-90" viewBox="0 0 36 36">
               <path
                 strokeDasharray="100, 100"
                 strokeDashoffset={100 - (timeLeft / activeFault.duration) * 100}
                 className="text-status-failing stroke-current"
                 strokeWidth="4"
                 fill="none"
                 d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
               />
             </svg>
             {(timeLeft / 1000).toFixed(1)}s
          </span>
        ) : (
          <span className="px-2 py-0.5 bg-status-healthy/10 text-status-healthy rounded text-[10px] font-bold border border-status-healthy/20 tracking-wider">
            ARMED
          </span>
        )}
      </div>
      
      <div className="grid grid-cols-2 gap-3">
        {CHAOS_ACTIONS.map((action, idx) => {
          const isConfirming = confirming === action.fault;
          const isActive = activeFault?.fault === action.fault;
          const disabled = (activeFault !== null && !isActive) || isActive;
          
          return (
            <button
              key={idx}
              disabled={disabled}
              onClick={() => handleAction(action.fault)}
              className={`flex items-center gap-2 p-3 rounded-md text-left transition duration-200 shadow-sm border ${
                isActive 
                  ? 'bg-status-failing/20 border-status-failing text-status-failing opacity-100 cursor-not-allowed' 
                  : isConfirming
                  ? 'bg-status-degraded/20 border-status-degraded text-status-degraded'
                  : 'bg-[#12161F] border-[#1E2530] hover:border-status-failing hover:text-white text-slate-300'
              } ${disabled && !isActive ? 'opacity-50 cursor-not-allowed hover:border-[#1E2530] hover:text-slate-300' : ''}`}
            >
              <span className="text-base shrink-0">{action.icon}</span>
              <span className="text-[10px] font-bold leading-tight tracking-wide">
                {isConfirming ? "Sure? This breaks a real city" : action.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
