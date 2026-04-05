import React, { useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, XCircle, Copy, Check } from 'lucide-react';

interface TerminalProps {
  logs: string[];
  onClear?: () => void;
}

export const Terminal: React.FC<TerminalProps> = ({ logs, onClear }) => {
  const endRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleCopy = () => {
    const text = logs.join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden flex flex-col h-[400px] shadow-2xl">
      <div className="bg-zinc-900 px-4 py-2 flex items-center justify-between border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-emerald-500" />
          <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">System Terminal</span>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleCopy}
            className="text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1.5"
            title="Copy Logs"
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            <span className="text-[10px] font-bold uppercase tracking-tighter">{copied ? 'Copied' : 'Copy'}</span>
          </button>
          {onClear && (
            <button 
              onClick={onClear}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Clear Terminal"
            >
              <XCircle size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 p-4 font-mono text-sm overflow-y-auto custom-scrollbar">
        {logs.length === 0 ? (
          <div className="text-zinc-600 italic">No output yet. Waiting for command...</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <span className="text-zinc-600 select-none">$</span>
              <span className={log.startsWith('ERROR') ? 'text-rose-400' : log.startsWith('SUCCESS') ? 'text-emerald-400' : 'text-zinc-300'}>
                {log}
              </span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
};
