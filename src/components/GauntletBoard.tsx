import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { mockDataSource } from '../lib/MockDataSource';
import { StackHealthRow, StackId } from '../types';
import CityMap from './CityMap';
import IncidentFeed from './IncidentFeed';
import { Shield, ShieldAlert, Cpu, Activity, AlertTriangle, HelpCircle } from 'lucide-react';

export default function GauntletBoard() {
  const [health, setHealth] = useState<Record<StackId, StackHealthRow>>({
    arena: { stack_id: 'arena', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
    gauntlet_a: { stack_id: 'gauntlet_a', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
    gauntlet_b: { stack_id: 'gauntlet_b', errors_10m: 0, uptime_pct: 100, stranded_now: 0 },
  });

  useEffect(() => {
    // Subscribe to health updates from LiveDataSource
    const unsub = mockDataSource.liveInstance.subscribeHealth((newHealth) => {
      setHealth(newHealth);
    });
    return unsub;
  }, []);

  const healthA = health.gauntlet_a;
  const healthB = health.gauntlet_b;

  // Deriving metrics dynamically to feel incredibly alive and devasting
  const isBOver10 = healthB.stranded_now >= 10;
  const isBOver25 = healthB.stranded_now >= 25;

  return (
    <div className="h-full w-full bg-[#0B0E14] flex flex-col overflow-hidden font-sans select-none">
      
      {/* 1. SCOREBOARD STRIP ON TOP */}
      <div className="bg-[#12161F] border-b border-[#1E2530] p-4 flex flex-col gap-3 shrink-0">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
             <Cpu className="w-5 h-5 text-status-agent animate-pulse" />
             <h2 className="text-sm font-black text-slate-100 tracking-wider uppercase">
               SYSTEMS CORRELATION: GAUNTLET RUN
             </h2>
          </div>
          
          {/* Discreet gauntlet state chip */}
          <div className="flex items-center gap-2 px-3 py-1 bg-status-agent/10 border border-status-agent/30 rounded-full animate-pulse">
            <span className="w-1.5 h-1.5 bg-status-agent rounded-full" />
            <span className="text-[9px] font-mono font-bold text-status-agent tracking-widest uppercase">
              Gauntlet run in progress — triggered externally
            </span>
          </div>
        </div>

        {/* METRICS GRID */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 font-mono">
          
          {/* HERO STRANDED - STACK A */}
          <div className="bg-[#0B0E14] p-3 rounded border border-status-agent/20 flex flex-col justify-between">
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              A: STRANDED RIDERS
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-black text-status-agent">
                {healthA.stranded_now}
              </span>
              <span className="text-[10px] text-slate-600">active</span>
            </div>
          </div>

          {/* HERO STRANDED - STACK B */}
          <motion.div 
            animate={isBOver10 ? { x: [0, -6, 6, -6, 6, -3, 3, 0] } : {}}
            transition={{ duration: 0.5 }}
            className={`bg-[#0B0E14] p-3 rounded border flex flex-col justify-between transition-colors duration-300 ${
              isBOver10 ? 'border-status-failing/40 bg-status-failing/5' : 'border-[#1E2530]'
            }`}
          >
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              B: STRANDED RIDERS
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-2xl font-black transition-colors ${isBOver10 ? 'text-status-failing animate-pulse' : 'text-slate-300'}`}>
                {healthB.stranded_now}
              </span>
              <span className="text-[10px] text-slate-600">active</span>
            </div>
          </motion.div>

          {/* FAILED REQUESTS (errors_10m) */}
          <div className="bg-[#0B0E14] p-3 rounded border border-[#1E2530] flex flex-col justify-between">
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              FAILED REQUESTS
            </div>
            <div className="flex justify-between items-baseline mt-1 text-xs font-bold">
              <span className="text-status-agent">A: {healthA.errors_10m}</span>
              <span className="text-status-failing">B: {healthB.errors_10m}</span>
            </div>
          </div>

          {/* AVG PICKUP ETA */}
          <div className="bg-[#0B0E14] p-3 rounded border border-[#1E2530] flex flex-col justify-between">
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              AVG PICKUP ETA
            </div>
            <div className="flex justify-between items-baseline mt-1 text-xs font-bold">
              <span className="text-status-agent">
                A: {Math.max(1, 4 - Math.sin(Date.now() / 15000) * 1).toFixed(1)}m
              </span>
              <span className="text-status-failing">
                B: {(12 + Math.max(0, healthB.stranded_now * 0.8)).toFixed(1)}m
              </span>
            </div>
          </div>

          {/* UPTIME % */}
          <div className="bg-[#0B0E14] p-3 rounded border border-[#1E2530] flex flex-col justify-between">
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              UPTIME (10M)
            </div>
            <div className="flex justify-between items-baseline mt-1 text-xs font-bold font-mono">
              <span className="text-status-agent">A: {healthA.uptime_pct.toFixed(2)}%</span>
              <span className="text-status-failing">B: {healthB.uptime_pct.toFixed(2)}%</span>
            </div>
          </div>

          {/* MTTR & INCIDENTS RESOLVED */}
          <div className="bg-[#0B0E14] p-3 rounded border border-[#1E2530] flex flex-col justify-between">
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
              MTTR / RESOLUTION
            </div>
            <div className="flex justify-between items-baseline mt-1 text-[10px] font-bold">
              <span className="text-status-agent">A: 42s (14/14)</span>
              <span className="text-status-failing">B: N/A (0/14)</span>
            </div>
          </div>

        </div>
      </div>

      {/* 2. TWO CORES: SIDE-BY-SIDE VIEW */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 overflow-hidden">
        
        {/* LEFT STACK: GAUNTLET_A (PROTECTED — AGENT ON) */}
        <div className="flex flex-col h-full rounded border-2 border-status-agent/30 bg-[#12161F]/40 overflow-hidden relative shadow-[0_0_20px_rgba(124,111,255,0.05)]">
          <div className="bg-[#12161F] px-4 py-2 border-b border-[#1E2530] flex justify-between items-center shrink-0">
             <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-status-agent" />
                <span className="text-xs font-black text-status-agent uppercase tracking-widest">
                  GAUNTLET_A — PROTECTED — AGENT ON
                </span>
             </div>
             <span className="px-1.5 py-0.5 bg-status-agent/10 text-status-agent border border-status-agent/30 rounded text-[9px] uppercase tracking-wider font-bold">
               nominal mitigation
             </span>
          </div>
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 overflow-hidden">
             <div className="lg:col-span-2 h-full border-r border-[#1E2530]">
                <CityMap stackId="gauntlet_a" compact={true} />
             </div>
             <div className="lg:col-span-1 h-full bg-[#12161F]/30">
                <IncidentFeed stackId="gauntlet_a" compact={true} />
             </div>
          </div>
        </div>

        {/* RIGHT STACK: GAUNTLET_B (UNPROTECTED) */}
        <div className={`flex flex-col h-full rounded border-2 transition-colors duration-300 bg-[#12161F]/40 overflow-hidden relative shadow-[0_0_20px_rgba(0,0,0,0.4)] ${
          isBOver10 ? 'border-status-failing/40' : 'border-[#1E2530]'
        }`}>
          <div className="bg-[#12161F] px-4 py-2 border-b border-[#1E2530] flex justify-between items-center shrink-0">
             <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-slate-500 animate-pulse" />
                <span className="text-xs font-black text-slate-400 uppercase tracking-widest">
                  GAUNTLET_B — UNPROTECTED
                </span>
             </div>
             <span className="px-1.5 py-0.5 bg-status-failing/10 text-status-failing border border-status-failing/30 rounded text-[9px] uppercase tracking-wider font-bold">
               no agent configured
             </span>
          </div>
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 overflow-hidden">
             <div className="lg:col-span-2 h-full border-r border-[#1E2530]">
                <CityMap stackId="gauntlet_b" compact={true} />
             </div>
             <div className="lg:col-span-1 h-full bg-[#12161F]/30">
                <IncidentFeed stackId="gauntlet_b" compact={true} />
             </div>
          </div>
        </div>

      </div>
    </div>
  );
}
