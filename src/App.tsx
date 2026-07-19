import React, { useState, useEffect } from 'react';
import TopBar from './components/TopBar';
import CityMap from './components/CityMap';
import DependencyGraph from './components/DependencyGraph';
import ChaosPanel from './components/ChaosPanel';
import IncidentFeed from './components/IncidentFeed';
import InvestigationBoard from './components/InvestigationBoard';
import GauntletBoard from './components/GauntletBoard';
import OriginView from './components/OriginView';
import { Compass, Tv, Info, Terminal } from 'lucide-react';
import { mockDataSource } from './lib/MockDataSource';

export default function App() {
  const [tab, setTab] = useState<'arena' | 'gauntlet'>('arena');
  const [centerView, setCenterView] = useState<'investigation' | 'topology'>('investigation');
  const [rightColumnTab, setRightColumnTab] = useState<'control' | 'origin'>('control');
  const [cinemaMode, setCinemaMode] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [showCtaBanner, setShowCtaBanner] = useState(true);

  // 1. Auto-dismiss welcome overlay in 10s
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowWelcome(false);
    }, 10000);
    return () => clearTimeout(timer);
  }, []);

  // 2. Proactive right column switch to Origin tracing when incident slice becomes ready
  useEffect(() => {
    const unsub = mockDataSource.subscribe((ev) => {
      if (ev.kind === 'slice_ready') {
        setRightColumnTab('origin');
      }
    });
    return unsub;
  }, []);

  // Wrapper element to lock 16:9 when Cinema Mode is on
  const renderCoreLayout = () => {
    if (tab === 'gauntlet') {
      return <GauntletBoard />;
    }

    return (
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 overflow-hidden">
        {/* Column 1: City Map */}
        <div className="hidden md:block lg:col-span-1 h-full">
          <CityMap stackId="arena" />
        </div>

        {/* Column 2: Center Column - Investigation / Topology */}
        <div className="hidden md:block md:col-span-1 lg:col-span-2 h-full relative border-r border-[#1E2530]">
          {!cinemaMode && (
            <div className="absolute top-4 right-4 z-30 flex bg-[#12161F] p-0.5 rounded border border-[#1E2530]">
              <button 
                onClick={() => setCenterView('investigation')}
                className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded transition-colors ${
                  centerView === 'investigation' ? 'bg-[#1E2530] text-slate-200' : 'text-slate-500 hover:text-slate-400'
                }`}
              >
                Investigation
              </button>
              <button 
                onClick={() => setCenterView('topology')}
                className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded transition-colors ${
                  centerView === 'topology' ? 'bg-[#1E2530] text-slate-200' : 'text-slate-500 hover:text-slate-400'
                }`}
              >
                Topology
              </button>
            </div>
          )}
          <div className="w-full h-full">
            {centerView === 'investigation' ? <InvestigationBoard /> : <DependencyGraph />}
          </div>
        </div>

        {/* Column 3: Right Column - Control / Origin Trace */}
        <div className="col-span-1 h-full flex flex-col bg-[#0B0E14] overflow-hidden">
          {/* Header toggles for right panel */}
          {!cinemaMode && (
            <div className="flex border-b border-[#1E2530] shrink-0 bg-[#12161F]">
              <button
                onClick={() => setRightColumnTab('control')}
                className={`flex-1 py-3 text-center text-[10px] font-black uppercase tracking-widest transition border-b-2 ${
                  rightColumnTab === 'control' 
                    ? 'border-status-agent text-status-agent bg-status-agent/5' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                Control Room
              </button>
              <button
                onClick={() => setRightColumnTab('origin')}
                className={`flex-1 py-3 text-center text-[10px] font-black uppercase tracking-widest transition border-b-2 ${
                  rightColumnTab === 'origin' 
                    ? 'border-[#22D3EE] text-[#22D3EE] bg-[#22D3EE]/5' 
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                Origin Trace
              </button>
            </div>
          )}

          <div className="flex-1 flex flex-col overflow-hidden">
            {rightColumnTab === 'control' ? (
              <>
                <div className={cinemaMode ? 'hidden' : 'block shrink-0'}>
                  <ChaosPanel />
                </div>
                <IncidentFeed stackId="arena" />
              </>
            ) : (
              <OriginView stackId="arena" />
            )}
          </div>
        </div>
      </div>
    );
  };

  const appContent = (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Dynamic CTA Fault Banner */}
      {showCtaBanner && !cinemaMode && tab === 'arena' && (
        <div className="bg-status-agent/10 border-b border-status-agent/20 px-6 py-2 text-xs font-bold text-slate-300 flex justify-between items-center z-40 shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-status-agent rounded-full animate-pulse" />
            <span>Think you can break the city? Fire a fault in the Chaos Panel →</span>
          </div>
          <button 
            onClick={() => setShowCtaBanner(false)} 
            className="text-slate-500 hover:text-slate-300 text-sm font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Panel Content */}
      {renderCoreLayout()}
    </div>
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-black text-slate-200 overflow-hidden font-sans relative">
      
      {/* 10-Second Welcome Overlay */}
      {showWelcome && (
        <div 
          onClick={() => setShowWelcome(false)}
          className="absolute inset-0 bg-[#0B0E14]/90 backdrop-blur-md z-[100] flex flex-col items-center justify-center p-6 cursor-pointer"
        >
          <div className="bg-[#12161F] border border-[#1E2530] p-8 rounded-lg max-w-md text-center flex flex-col items-center gap-4 shadow-2xl">
            <div className="p-4 rounded-full bg-status-agent/10 border border-status-agent/30 text-status-agent">
              <Terminal className="w-8 h-8 animate-pulse" />
            </div>
            <h2 className="text-md font-black text-slate-100 tracking-wider uppercase font-mono">
              CHAOS ARENA CONTROL
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed font-sans">
              Welcome to the hackathon demonstration control panel. Inject custom server-side faults, watch the SRE trace root causes, and monitor Gauntlet mitigation.
            </p>
            <div className="text-[10px] font-mono text-status-agent uppercase tracking-widest mt-2 animate-pulse">
              Click anywhere to boot terminal
            </div>
          </div>
        </div>
      )}

      {/* RENDER BODY WITH 16:9 LETTERBOX LATCH */}
      {cinemaMode ? (
        <div className="h-screen w-screen bg-black flex items-center justify-center p-4">
          <div className="aspect-video w-full max-w-7xl max-h-full bg-[#0B0E14] border border-[#1E2530] flex flex-col relative overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.9)] rounded">
            <TopBar tab={tab} onTabChange={setTab} cinemaMode={cinemaMode} />
            {appContent}
          </div>
        </div>
      ) : (
        <div className="h-full w-full flex flex-col overflow-hidden">
          <TopBar tab={tab} onTabChange={setTab} cinemaMode={cinemaMode} />
          {appContent}
        </div>
      )}

      {/* Floating Utilities */}
      <div className="absolute bottom-4 right-4 z-[90] flex items-center gap-2">
        <button
          onClick={() => setCinemaMode(!cinemaMode)}
          className={`px-3 py-1.5 rounded border text-[10px] font-mono font-bold tracking-wider uppercase transition flex items-center gap-1.5 shadow-lg ${
            cinemaMode 
              ? 'bg-status-agent/20 border-status-agent text-slate-200' 
              : 'bg-[#12161F] border-[#1E2530] text-slate-400 hover:text-slate-200 hover:border-slate-500'
          }`}
        >
          <Tv className="w-3.5 h-3.5" />
          {cinemaMode ? 'Exit Cinema' : 'Cinema Mode'}
        </button>
      </div>

    </div>
  );
}
