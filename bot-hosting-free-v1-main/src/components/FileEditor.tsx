import React, { useState, useEffect } from 'react';
import { X, Save, Loader2, Check } from 'lucide-react';
import { motion } from 'motion/react';

interface FileEditorProps {
  projectId: string;
  filePath: string;
  onClose: () => void;
  onSaveSuccess?: () => void;
}

export const FileEditor: React.FC<FileEditorProps> = ({ projectId, filePath, onClose, onSaveSuccess }) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchContent = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`, {
          headers: { 'x-project-id': projectId }
        });
        if (!response.ok) throw new Error('Failed to fetch file content');
        const data = await response.json();
        setContent(data.content);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchContent();
  }, [projectId, filePath]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const response = await fetch('/api/save-file', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-project-id': projectId 
        },
        body: JSON.stringify({ path: filePath, content })
      });
      if (!response.ok) throw new Error('Failed to save file');
      setSaved(true);
      if (onSaveSuccess) onSaveSuccess();
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden shadow-2xl"
      >
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <Save size={20} className="text-blue-500" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Edit File</h2>
              <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">{filePath}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-zinc-500 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 p-6 overflow-hidden flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="animate-spin text-emerald-500" size={32} />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-rose-500 gap-2">
              <X size={20} />
              <span>{error}</span>
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex-1 w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 font-mono text-sm text-zinc-300 focus:ring-1 focus:ring-emerald-500/50 focus:outline-none transition-all resize-none custom-scrollbar"
              spellCheck={false}
            />
          )}
        </div>

        <div className="px-6 py-4 bg-zinc-950/50 border-t border-zinc-800 flex justify-between items-center">
          <p className="text-[10px] text-zinc-500 italic">
            * Changes are saved directly to the server.
          </p>
          <div className="flex items-center gap-3">
            <button 
              onClick={onClose}
              className="px-6 py-2 text-zinc-400 hover:text-white transition-all text-sm font-bold"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave}
              disabled={loading || saving}
              className={`px-8 py-2 rounded-xl font-bold transition-all flex items-center gap-2 shadow-lg active:scale-95 ${saved ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-100 hover:bg-white text-zinc-950'} disabled:opacity-50`}
            >
              {saving ? <Loader2 className="animate-spin" size={18} /> : saved ? <Check size={18} /> : <Save size={18} />}
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
