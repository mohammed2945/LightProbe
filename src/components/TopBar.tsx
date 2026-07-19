import React, { useState } from 'react';
import { Copy, Check, Activity, Zap } from 'lucide-react';
import { mockDataSource } from '../lib/MockDataSource';

export default function TopBar({ 
  tab, 
  onTabChange, 
  cinemaMode 
}: { 
  tab: 'arena' | 'gauntlet', 
  onTabChange: (t: 'arena' | 'gauntlet') => void,
  cinemaMode: boolean
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="h-14 border-b border-border-subtle bg-bg-panel flex items-center justify-between px-6 shrink-0 z-50">
      <div className="flex items-center gap-6">
        <h1 className="text-sm font-black tracking-widest text-slate-100 uppercase">
          CHAOS ARENA <span className="text-slate-600 font-medium mx-1">—</span> BREAK THE CITY
        </h1>
        
        {!cinemaMode && (
          <div className="hidden sm:flex items-center bg-bg-base rounded-md p-0.5 border border-border-subtle">
            <button 
              onClick={() => onTabChange('arena')}
              className={`px-3 py-1 text-xs font-bold rounded transition ${
                tab === 'arena' ? 'bg-[#1E2530] text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Arena
            </button>
            <button 
              onClick={() => onTabChange('gauntlet')}
              className={`px-3 py-1 text-xs font-bold rounded transition ${
                tab === 'gauntlet' ? 'bg-[#1E2530] text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Gauntlet
            </button>
            <button 
               onClick={() => mockDataSource.triggerInvestigation()} 
               className="px-3 py-1 text-xs font-bold text-status-agent hover:text-white transition flex items-center gap-1 ml-2"
            >
               Replay Trace
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {!cinemaMode && (
          <>
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-status-healthy/10 border border-status-healthy/20 rounded-full">
              <Activity className="w-3.5 h-3.5 text-status-healthy" />
              <span className="text-xs font-bold text-status-healthy tracking-wider">CITY NOMINAL</span>
            </div>

            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-status-degraded/10 border border-status-degraded/20 rounded-full">
              <Zap className="w-3.5 h-3.5 text-status-degraded" />
              <span className="text-xs font-mono font-bold text-status-degraded tracking-wider">SURGE 1.0x</span>
            </div>

            <button 
              onClick={handleCopy}
              className="flex items-center gap-2 px-3 py-1.5 bg-bg-base hover:bg-border-subtle border border-border-subtle rounded-md text-xs font-semibold transition text-slate-300 shadow-sm"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-status-healthy" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
              {copied ? 'Copied' : 'Share'}
            </button>
          </>
        )}
        {cinemaMode && (
          <div className="flex items-center gap-2 px-3 py-1 bg-status-agent/10 border border-status-agent/30 rounded-full animate-pulse">
            <span className="w-1.5 h-1.5 bg-status-agent rounded-full" />
            <span className="text-xs font-mono font-bold text-status-agent tracking-widest uppercase">
              CINEMA DEMO LIVE
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
