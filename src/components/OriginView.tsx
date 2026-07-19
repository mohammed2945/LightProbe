import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { mockDataSource } from '../lib/MockDataSource';
import { ArenaEvent, StackId } from '../types';
import { Crown, Check, AlertCircle, RefreshCw, GitPullRequest, ArrowDown, Compass } from 'lucide-react';

interface Node {
  id: string;
  label: string;
  role: 'candidate' | 'manifestation';
  isArmed?: boolean;
  snapshot?: {
    trace_id: string;
    expr: string;
    value: string;
    population: 'failing' | 'passing';
  };
  isExonerated?: boolean;
  exoneratedReason?: string;
  isOrigin?: boolean;
}

interface Edge {
  from: string;
  to: string;
}

export default function OriginView({ stackId = 'arena' }: { stackId?: StackId }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [originFound, setOriginFound] = useState<any>(null);
  const [proposedFix, setProposedFix] = useState<any>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const unsub = mockDataSource.subscribe((ev) => {
      if (ev.kind === 'slice_ready') {
        const payload = ev.payload as any;
        const newNodes = payload.slice.nodes.map((n: any) => ({
          ...n,
          isArmed: false,
          snapshot: undefined,
          isExonerated: false,
          isOrigin: false
        }));
        setNodes(newNodes);
        setEdges(payload.slice.edges || []);
        setOriginFound(null);
        setProposedFix(null);
        setIsActive(true);
      } else if (ev.kind === 'probes_armed') {
        const payload = ev.payload as any;
        setNodes(prev => prev.map(node => {
          if (payload.node_ids.includes(node.id)) {
            return { ...node, isArmed: true };
          }
          return node;
        }));
      } else if (ev.kind === 'snapshot') {
        const payload = ev.payload as any;
        setNodes(prev => prev.map(node => {
          if (node.id === payload.node_id) {
            return {
              ...node,
              snapshot: {
                trace_id: payload.trace_id,
                expr: payload.expr,
                value: payload.value,
                population: payload.population
              }
            };
          }
          return node;
        }));
      } else if (ev.kind === 'exonerated') {
        const payload = ev.payload as any;
        setNodes(prev => prev.map(node => {
          if (payload.node_ids.includes(node.id)) {
            return {
              ...node,
              isExonerated: true,
              isArmed: false,
              exoneratedReason: payload.reason
            };
          }
          return node;
        }));
      } else if (ev.kind === 'origin_found') {
        const payload = ev.payload as any;
        setNodes(prev => prev.map(node => {
          // Identify origin by matching label or id
          const isOriginNode = prev.find(n => n.label === payload.origin)?.id === node.id || node.label === payload.origin;
          return {
            ...node,
            isOrigin: isOriginNode,
            isArmed: isOriginNode ? false : node.isArmed
          };
        }));
        setOriginFound(payload);
      } else if (ev.kind === 'fix_proposed') {
        const payload = ev.payload as any;
        setProposedFix(payload);
      }
    }, stackId);

    return unsub;
  }, [stackId]);

  const handleReplay = () => {
    mockDataSource.triggerInvestigation();
  };

  const handleReset = () => {
    setNodes([]);
    setEdges([]);
    setOriginFound(null);
    setProposedFix(null);
    setIsActive(false);
  };

  return (
    <div className="h-full w-full bg-[#12161F] flex flex-col overflow-hidden text-sans select-none">
      
      {/* HEADER SECTION */}
      <div className="p-4 border-b border-[#1E2530] flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-[#22D3EE] animate-spin-slow" />
          <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
            ORIGIN <span className="text-[#22D3EE] font-black">· LIVE TRACE</span>
          </h2>
        </div>
        
        {isActive && (
          <button 
            onClick={handleReset}
            className="text-[9px] font-mono text-slate-500 hover:text-slate-300 font-bold uppercase transition"
          >
            Clear
          </button>
        )}
      </div>

      {/* CONTENT AREA */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        
        <AnimatePresence mode="wait">
          {!isActive ? (
            /* EMPTY STATE */
            <motion.div 
              key="empty"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex-1 flex flex-col items-center justify-center text-center p-6"
            >
              <div className="p-4 rounded-full bg-[#0B0E14] border border-[#1E2530] mb-4">
                <Compass className="w-8 h-8 text-slate-700" />
              </div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">
                No active root-cause trace
              </h3>
              <p className="text-[10px] text-slate-600 font-medium max-w-[200px] mt-2 mb-6">
                Active root-cause traces trigger dynamically when a critical breach or fault is injected.
              </p>
              
              <button
                onClick={handleReplay}
                className="px-4 py-2 bg-status-agent/20 hover:bg-status-agent/30 border border-status-agent/40 text-status-agent text-xs font-black rounded transition shadow-sm font-sans uppercase tracking-wider"
              >
                Replay fare_corrupt
              </button>
            </motion.div>
          ) : (
            /* ACTIVE INVESTIGATION VIEW */
            <motion.div 
              key="active"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col gap-4"
            >
              
              {/* STAGE DESCRIPTION */}
              <div className="bg-[#0B0E14] p-3 rounded border border-[#1E2530] flex flex-col gap-1 shrink-0">
                <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest">
                  STREAM STATUS
                </span>
                <span className="text-xs font-bold text-slate-200">
                  {proposedFix ? 'Fix Proposed' : originFound ? 'Origin Discovered' : 'Analyzing anomalous execution stack...'}
                </span>
                <div className="w-full bg-[#1E2530] h-1.5 rounded-full mt-2 overflow-hidden">
                  <div 
                    className="bg-[#22D3EE] h-full transition-all duration-500"
                    style={{ 
                      width: proposedFix ? '100%' : originFound ? '85%' : nodes.some(n => n.snapshot) ? '55%' : '20%' 
                    }}
                  />
                </div>
              </div>

              {/* VERTICAL DAG NODES LIST */}
              <div className="flex flex-col items-center py-4 bg-[#0B0E14] rounded border border-[#1E2530] relative overflow-hidden">
                <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-[#1E2530] -translate-x-1/2 z-0" />
                
                <div className="flex flex-col gap-6 items-center w-full z-10">
                  {nodes.map((node, index) => {
                    const isManifestation = node.role === 'manifestation';
                    const hasSnapshot = !!node.snapshot;
                    
                    return (
                      <React.Fragment key={node.id}>
                        {/* Connected line indicator */}
                        {index > 0 && (
                          <div className="h-2 flex items-center justify-center -my-3 z-20">
                            <ArrowDown className={`w-3.5 h-3.5 ${
                              originFound && index <= nodes.findIndex(n => n.isOrigin) 
                                ? 'text-[#22D3EE]' 
                                : 'text-slate-700'
                            }`} />
                          </div>
                        )}

                        {/* Node Card */}
                        <motion.div 
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: node.isExonerated ? 0.25 : 1, scale: 1 }}
                          transition={{ duration: 0.3 }}
                          className={`w-[90%] max-w-[280px] p-3 rounded border transition-all duration-300 flex flex-col gap-2 relative bg-[#12161F] ${
                            node.isOrigin 
                              ? 'border-[#22D3EE] shadow-[0_0_15px_rgba(34,211,238,0.25)]' 
                              : node.isArmed 
                                ? 'border-[#22D3EE]/60' 
                                : isManifestation 
                                  ? 'border-status-failing/40' 
                                  : 'border-[#1E2530]'
                          }`}
                        >
                          {/* Top row: Label & Badges */}
                          <div className="flex justify-between items-start gap-2">
                            <span className={`text-[10px] font-mono font-bold truncate ${
                              node.isOrigin 
                                ? 'text-[#22D3EE] font-black' 
                                : node.isExonerated 
                                  ? 'text-slate-600 line-through' 
                                  : 'text-slate-200'
                            }`}>
                              {node.label}
                            </span>
                            
                            {/* Role Badge */}
                            {node.isOrigin ? (
                              <div className="px-1.5 py-0.5 bg-[#22D3EE]/10 border border-[#22D3EE]/30 rounded flex items-center gap-1 shrink-0">
                                <Crown className="w-2.5 h-2.5 text-[#22D3EE]" />
                                <span className="text-[8px] font-mono font-black text-[#22D3EE] uppercase tracking-wider">
                                  ORIGIN
                                </span>
                              </div>
                            ) : isManifestation ? (
                              <div className="px-1.5 py-0.5 bg-status-failing/10 border border-status-failing/30 rounded flex items-center gap-1 shrink-0">
                                <AlertCircle className="w-2.5 h-2.5 text-status-failing" />
                                <span className="text-[8px] font-mono font-bold text-status-failing uppercase tracking-wider">
                                  BREACH
                                </span>
                              </div>
                            ) : node.isExonerated ? (
                              <div className="px-1.5 py-0.5 bg-slate-800/40 border border-slate-700/30 rounded flex items-center gap-1 shrink-0">
                                <Check className="w-2.5 h-2.5 text-slate-500" />
                                <span className="text-[8px] font-mono font-bold text-slate-500 uppercase tracking-wider">
                                  EXONERATED
                                </span>
                              </div>
                            ) : null}
                          </div>

                          {/* Subtext state (Armed, Reason, etc) */}
                          {node.isArmed && (
                            <div className="flex items-center gap-1 text-[9px] font-mono font-bold text-[#22D3EE] uppercase tracking-widest animate-pulse">
                              <span className="w-1.5 h-1.5 bg-[#22D3EE] rounded-full animate-ping" />
                              <span>PROBE ARMED — LISTENING...</span>
                            </div>
                          )}

                          {node.isExonerated && node.exoneratedReason && (
                            <p className="text-[9px] font-sans italic text-slate-500">
                              {node.exoneratedReason}
                            </p>
                          )}

                          {/* Snapshot values */}
                          {hasSnapshot && (
                            <div className="bg-[#0B0E14] p-2 rounded border border-[#1E2530] font-mono text-[9px] flex flex-col gap-1 mt-1">
                              <div className="flex justify-between text-slate-500">
                                <span>expr: {node.snapshot?.expr}</span>
                                <span className="text-[#22D3EE]">{node.snapshot?.trace_id}</span>
                              </div>
                              <div className="flex justify-between items-baseline">
                                <span className="text-status-failing font-bold">
                                  val = {node.snapshot?.value}
                                </span>
                                <span className="px-1 py-0.2 bg-status-failing/10 text-status-failing rounded text-[8px] font-black uppercase">
                                  {node.snapshot?.population}
                                </span>
                              </div>
                            </div>
                          )}

                        </motion.div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* PROPOSED FIX (PR CARD) */}
              {proposedFix && (
                <motion.div 
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#0B0E14] rounded border border-status-agent/30 shadow-[0_0_15px_rgba(124,111,255,0.15)] overflow-hidden shrink-0 mt-2"
                >
                  <div className="bg-status-agent/10 px-3 py-2 border-b border-status-agent/20 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <GitPullRequest className="w-4 h-4 text-status-agent" />
                      <span className="text-xs font-black text-status-agent tracking-wider uppercase">
                        PROPOSED FIX
                      </span>
                    </div>
                    <span className="px-1.5 py-0.5 bg-status-agent/10 text-status-agent border border-status-agent/30 rounded text-[9px] uppercase tracking-wider font-bold">
                      Ready for Merge
                    </span>
                  </div>

                  <div className="p-3 flex flex-col gap-2">
                    <h4 className="text-xs font-bold text-slate-200">
                      {proposedFix.title}
                    </h4>
                    
                    <p className="text-[9px] text-slate-500 font-semibold font-mono">
                      Witnessed: {proposedFix.witnessed}
                    </p>

                    {/* Diff Viewer */}
                    <div className="bg-[#12161F] p-2 rounded border border-[#1E2530] font-mono text-[9px] overflow-x-auto text-slate-400 leading-relaxed max-h-[140px] whitespace-pre">
                      {proposedFix.diff_summary.split('\n').map((line: string, idx: number) => {
                        const isAdd = line.startsWith('+');
                        const isDel = line.startsWith('-');
                        return (
                          <div 
                            key={idx} 
                            className={`${
                              isAdd ? 'bg-status-healthy/10 text-status-healthy' : 
                              isDel ? 'bg-status-failing/10 text-status-failing' : 
                              'text-slate-400'
                            } px-1 rounded-sm`}
                          >
                            {line}
                          </div>
                        );
                      })}
                    </div>

                    <a 
                      href={proposedFix.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full mt-2 py-1.5 bg-status-agent/20 hover:bg-status-agent/30 border border-status-agent/40 text-status-agent rounded text-center text-xs font-bold uppercase tracking-wider transition block"
                    >
                      Inspect Pull Request
                    </a>
                  </div>
                </motion.div>
              )}

            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
