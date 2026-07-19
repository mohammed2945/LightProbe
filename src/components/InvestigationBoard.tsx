import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { mockDataSource } from '../lib/MockDataSource';
import { ArenaEvent, OriginEventPayload } from '../types';
import { Check, X, Clock, GitPullRequest } from 'lucide-react';

export default function InvestigationBoard() {
  const [candidates, setCandidates] = useState<{service: string, confidence: number}[] | null>(null);
  const [probes, setProbes] = useState<OriginEventPayload[]>([]);
  const [snapshots, setSnapshots] = useState<OriginEventPayload[]>([]);
  const [verdict, setVerdict] = useState<OriginEventPayload | null>(null);
  const [fixProposed, setFixProposed] = useState<OriginEventPayload | null>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const unsub = mockDataSource.subscribe((ev: ArenaEvent) => {
      if (['hypothesis', 'probe_status', 'snapshot', 'origin_found', 'fix_proposed'].includes(ev.kind)) {
        setIsActive(true);
      }
      
      if (ev.kind === 'hypothesis') {
        const payload = ev.payload as any;
        if (payload.candidates) {
          const sorted = [...payload.candidates].sort((a: any, b: any) => b.confidence - a.confidence);
          setCandidates(sorted);
        }
      } else if (ev.kind === 'probe_status') {
        const payload = ev.payload as any;
        setProbes(prev => {
          const existing = [...prev];
          const idx = existing.findIndex((p: any) => p.probe_id === payload.probe_id);
          if (idx >= 0) {
            existing[idx] = { ...existing[idx], ...payload };
            return existing;
          } else {
            return [payload, ...existing];
          }
        });
      } else if (ev.kind === 'snapshot') {
        const payload = ev.payload as any;
        setSnapshots(prev => {
          const next = [payload, ...prev];
          if (next.length > 5) return next.slice(0, 5);
          return next;
        });
      } else if (ev.kind === 'origin_found') {
        setVerdict(ev.payload as any);
      } else if (ev.kind === 'fix_proposed') {
        setFixProposed(ev.payload as any);
      }
    });

    return unsub;
  }, []);

  if (!isActive) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 font-mono text-xs">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-status-origin animate-pulse opacity-70"></div>
          LiveProbe idle — waiting for an incident
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col overflow-y-auto overflow-x-hidden p-6 gap-8 text-sm">
      {/* 1. ACTIVE HYPOTHESES */}
      <div className="flex flex-col gap-3">
        <h3 className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">Active Hypotheses</h3>
        <div className="flex flex-col gap-2">
          <AnimatePresence mode="popLayout">
            {candidates?.map((c, idx) => (
              <motion.div 
                key={c.service} 
                layout 
                className={`flex items-center gap-3 transition-opacity duration-300 ${c.confidence < 10 ? 'opacity-40' : 'opacity-100'}`}
              >
                <div className="w-24 text-right font-mono text-xs text-slate-300 truncate">{c.service}</div>
                <div className="flex-1 bg-[#1A2130] h-6 rounded overflow-hidden relative">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${c.confidence}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className={`h-full ${idx === 0 ? 'bg-status-origin' : 'bg-[#1E2530]'}`}
                  />
                  <div className="absolute inset-0 flex items-center px-2">
                    <span className={`font-mono text-[10px] font-bold ${idx === 0 ? 'text-bg-base' : 'text-slate-300'}`}>
                      {c.confidence}%
                    </span>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* 2. PROBE LIFECYCLE */}
      <div className="flex flex-col gap-3">
        <h3 className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">Probe Lifecycle</h3>
        <div className="flex flex-col gap-1.5 font-mono text-xs">
          <AnimatePresence initial={false}>
            {probes.slice(0, 6).map((p) => (
              <motion.div 
                key={p.probe_id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-3 p-2 bg-[#12161F] border border-[#1E2530] rounded"
              >
                <div className="w-4 h-4 flex items-center justify-center shrink-0">
                  {p.status === 'created' && <div className="w-2.5 h-2.5 rounded-full border-2 border-slate-600" />}
                  {p.status === 'armed' && <div className="w-2.5 h-2.5 rounded-full border-2 border-status-origin animate-pulse" />}
                  {p.status === 'hit' && (
                    <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring' }}>
                      <Check className="w-4 h-4 text-status-origin" />
                    </motion.div>
                  )}
                  {p.status === 'error' && <X className="w-4 h-4 text-status-failing" />}
                  {p.status === 'expired' && <Clock className="w-3.5 h-3.5 text-slate-600" />}
                </div>
                <div className="flex-1 truncate text-slate-300">
                  {p.service} <span className="text-slate-600">·</span> {p.file_line}
                </div>
                {p.type && (
                  <div className="px-1.5 py-0.5 bg-[#1A2130] text-slate-400 rounded text-[9px] uppercase tracking-wider">
                    {p.type}
                  </div>
                )}
                {p.status === 'error' && p.error && (
                  <div className="text-status-failing text-[10px] truncate max-w-[100px]">{p.error}</div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
          {probes.length > 6 && (
            <div className="text-slate-600 text-center py-2 text-[10px] uppercase tracking-widest">
              + {probes.length - 6} earlier probes
            </div>
          )}
        </div>
      </div>

      {/* 3. EVIDENCE */}
      {snapshots.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">Evidence</h3>
          <div className="flex flex-wrap gap-2 font-mono text-xs">
            <AnimatePresence>
              {snapshots.map(s => (
                <motion.div
                  key={s.trace_id + '-' + s.node_id}
                  initial={{ opacity: 0, x: 20, backgroundColor: 'rgba(34, 211, 238, 0.2)' }}
                  animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(30, 37, 48, 1)' }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                  className="px-3 py-1.5 rounded border border-[#1E2530] text-slate-300 flex items-center gap-2"
                >
                  <span className="text-slate-400">{s.expr}</span>
                  <span className="text-slate-600">=</span>
                  <span className="text-status-origin font-bold">{s.value}</span>
                  <span className="text-slate-600 text-[10px] ml-1">#{s.trace_id?.slice(-4)}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* 4. VERDICT */}
      {verdict && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 p-4 border border-status-origin/30 bg-status-origin/5 rounded-md relative overflow-hidden mt-4"
        >
          <motion.div 
             initial={{ left: '-100%' }}
             animate={{ left: '100%' }}
             transition={{ duration: 0.6, ease: "easeInOut" }}
             className="absolute top-0 bottom-0 w-24 bg-gradient-to-r from-transparent via-status-origin to-transparent opacity-20 skew-x-12"
          />
          <div className="flex items-center justify-between z-10 relative">
            <h3 className="text-[10px] font-bold tracking-widest text-status-origin uppercase">Root Cause</h3>
            <span className="px-2 py-0.5 bg-status-origin/10 text-status-origin border border-status-origin/20 rounded text-[9px] uppercase tracking-wider font-bold">
              {verdict.confidence} CONFIDENCE
            </span>
          </div>
          
          <div className="font-mono text-xl text-status-origin font-bold z-10 relative">
            {verdict.origin}
          </div>
          
          <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-slate-500 z-10 relative">
            {verdict.chain?.map((c, i) => (
              <React.Fragment key={i}>
                <span>{c}</span>
                {i < (verdict.chain?.length || 0) - 1 && <span>→</span>}
              </React.Fragment>
            ))}
          </div>

          {fixProposed && (
            <div className="mt-4 p-3 bg-bg-base border border-border-subtle rounded flex flex-col gap-3 z-10 relative">
              <div className="flex items-center gap-2 text-slate-300">
                <GitPullRequest className="w-4 h-4 text-status-origin" />
                <span className="font-bold text-sm">{fixProposed.title}</span>
              </div>
              <div className="font-mono text-[10px] p-2 bg-[#0B0E14] rounded border border-[#1E2530] whitespace-pre text-slate-400">
                {fixProposed.diff_summary?.split('\n').map((line, i) => (
                  <div key={i} className={line.startsWith('+') ? 'text-status-healthy' : line.startsWith('-') ? 'text-status-failing' : ''}>
                    {line}
                  </div>
                ))}
              </div>
              <div className="flex justify-between items-center text-xs">
                 <span className="font-mono text-[10px] text-slate-500">Witnessed: {fixProposed.witnessed}</span>
                 {fixProposed.pr_url && (
                   <a href={fixProposed.pr_url} target="_blank" rel="noreferrer" className="text-status-origin hover:underline flex items-center gap-1 font-bold">
                     View PR
                   </a>
                 )}
              </div>
            </div>
          )}
        </motion.div>
      )}

    </div>
  );
}
