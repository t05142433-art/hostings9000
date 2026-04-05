import React, { useState, useCallback, useEffect, useRef } from 'react';
import { 
  Archive, 
  Terminal as TerminalIcon, 
  Download, 
  Play, 
  Settings, 
  Cpu, 
  Globe, 
  ShieldCheck, 
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  FileJson,
  Code2,
  FileCode2,
  Package,
  ExternalLink,
  Zap,
  Square,
  Trash2,
  Search,
  FolderOpen,
  Github
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { io, Socket } from 'socket.io-client';
import { ProjectFile, StackType, ProjectState } from './types';
import { detectStack } from './utils/stackDetector';
import { exportToZip } from './utils/zipExporter';
import { FileUploader } from './components/FileUploader';
import { Terminal } from './components/Terminal';
import { FileEditor } from './components/FileEditor';

const App: React.FC = () => {
  const [state, setState] = useState<ProjectState>({
    files: [],
    stack: 'unknown',
    status: 'idle',
    logs: [],
  });

  const [projectId, setProjectId] = useState(() => {
    const saved = localStorage.getItem('project_porter_id');
    if (saved) return saved;
    const newId = `project-${Math.random().toString(36).substring(2, 11)}`;
    localStorage.setItem('project_porter_id', newId);
    return newId;
  });

  const switchProject = (id: string) => {
    setProjectId(id);
    localStorage.setItem('project_porter_id', id);
    setAltTunnelUrl(null);
    setAltTunnelPassword(null);
    setPublicUrl(null);
    setState(prev => ({ ...prev, status: 'idle', logs: [] }));
    setShowProjectsTab(false);
  };
  const [projectName, setProjectName] = useState('my-awesome-project');
  const [mainFile, setMainFile] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [altTunnelUrl, setAltTunnelUrl] = useState<string | null>(null);
  const [altTunnelPassword, setAltTunnelPassword] = useState<string | null>(null);
  const [runningProjects, setRunningProjects] = useState<{ projectId: string, startTime: number, hasTunnel: boolean }[]>([]);
  const [allProjects, setAllProjects] = useState<string[]>([]);
  const [showRunningTab, setShowRunningTab] = useState(false);
  const [showProjectsTab, setShowProjectsTab] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const fetchRunningProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/running-projects');
      const data = await response.json();
      setRunningProjects(data);
    } catch (err) {
      console.error('Failed to fetch running projects:', err);
    }
  }, []);

  const fetchAllProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/projects');
      const data = await response.json();
      setAllProjects(data);
    } catch (err) {
      console.error('Failed to fetch all projects:', err);
    }
  }, []);

  const checkProjectStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/project-status', {
        headers: { 'x-project-id': projectId }
      });
      const data = await response.json();
      
      if (data.running) {
        setState(prev => ({
          ...prev,
          status: 'running',
          logs: data.logs || []
        }));
        if (data.tunnelUrl) {
          setAltTunnelUrl(data.tunnelUrl);
        }
        setPublicUrl(`${window.location.origin}/p/${projectId}/`);
      }

      const infoResponse = await fetch('/api/project-info', {
        headers: { 'x-project-id': projectId }
      });
      const infoData = await infoResponse.json();
      if (infoData.exists) {
        const files: ProjectFile[] = infoData.files.map((f: string) => ({
          name: f.split('/').pop() || f,
          path: f,
          content: '',
          type: f.endsWith('/') ? 'directory' : 'file'
        }));
        const stack = detectStack(files);
        setState(prev => ({
          ...prev,
          files,
          stack,
          logs: data.running ? prev.logs : [...prev.logs, `System: Project recovered from server. ${files.length} items found.`]
        }));
      }
    } catch (err) {
      console.error('Failed to check project status:', err);
    }
  }, [projectId]);

  useEffect(() => {
    checkProjectStatus();
  }, [checkProjectStatus]);

  const addLog = useCallback((message: string) => {
    setState(prev => ({
      ...prev,
      logs: [...prev.logs, `[LOCAL] ${message}`]
    }));
  }, []);

  const runCommand = useCallback((command: string, args: string[], autoStart?: boolean) => {
    if (!socketRef.current) return;
    socketRef.current.emit('run-command', {
      command,
      args,
      projectId,
      stack: state.stack,
      autoStart
    });
  }, [state.stack, projectId]);

  const startProject = useCallback(() => {
    setState(prev => ({ ...prev, status: 'running' }));
    
    if (customCommand) {
      const parts = customCommand.split(' ');
      runCommand(parts[0], parts.slice(1));
    } else if (state.stack === 'python') {
      const fileToRun = mainFile || state.files.find(f => f.name === 'main.py' || f.name === 'app.py')?.name || 'main.py';
      runCommand('python', [fileToRun]);
    } else if (state.stack === 'vite') {
      runCommand('npm', ['run', 'dev', '--', '--host', '0.0.0.0']);
    } else {
      // For Node.js, if mainFile is set, use node mainFile, else npm start
      if (mainFile) {
        runCommand('node', [mainFile]);
      } else {
        runCommand('npm', ['start']);
      }
    }
    setPublicUrl(`${window.location.origin}/p/${projectId}/`);
  }, [state.stack, state.files, projectId, runCommand, mainFile, customCommand]);

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.emit('join-project', { projectId });

    socket.on('log', (message: string) => {
      setState(prev => ({
        ...prev,
        logs: [...prev.logs, message]
      }));
    });

    socket.on('command-success', ({ autoStart }: { autoStart?: boolean }) => {
      if (autoStart) {
        setState(prev => ({ ...prev, logs: [...prev.logs, 'System: Dependencies installed. Auto-starting project...'] }));
        startProject();
      }
      fetchRunningProjects();
    });

    socket.on('retry-command', ({ command, args, autoStart }: { command: string, args: string[], autoStart?: boolean }) => {
      runCommand(command, args, autoStart);
    });

    socket.on('alt-tunnel-ready', (data: { url: string, password?: string } | string | null) => {
      if (typeof data === 'object' && data !== null) {
        setAltTunnelUrl(data.url);
        setAltTunnelPassword(data.password || null);
      } else {
        setAltTunnelUrl(data as string | null);
        setAltTunnelPassword(null);
      }
      fetchRunningProjects();
    });

    return () => {
      socket.disconnect();
    };
  }, [startProject]);

  const handleFilesSelected = async (files: ProjectFile[]) => {
    const stack = detectStack(files);
    
    // Auto-detect main file
    let detectedMain = '';
    if (stack === 'node') {
      const candidates = ['server.js', 'app.js', 'index.js', 'main.js', 'server.ts', 'app.ts', 'index.ts'];
      const found = files.find(f => candidates.includes(f.name));
      if (found) detectedMain = found.name;
    } else if (stack === 'python') {
      const found = files.find(f => f.name === 'main.py' || f.name === 'app.py');
      if (found) detectedMain = found.name;
    }
    if (detectedMain) setMainFile(detectedMain);

    setState(prev => ({
      ...prev,
      files,
      stack,
      status: 'idle',
      logs: [`Project loaded: ${files.length} files detected.`, `Stack identified: ${stack.toUpperCase()}`]
    }));
    
    if (files.length > 0) {
      const firstDir = files[0].path.split('/')[0];
      if (firstDir && firstDir !== files[0].name) {
        setProjectName(firstDir.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase());
      }
    }
  };

  const uploadFiles = async (files: File[]) => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file, file.webkitRelativePath || file.name);
    });

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-project-id': projectId },
        body: formData
      });
      if (response.ok) {
        addLog('SUCCESS: Files uploaded to backend storage.');
      }
    } catch (err) {
      addLog(`ERROR: Upload failed: ${err}`);
    }
  };

  const stopProcess = () => {
    if (!socketRef.current) return;
    socketRef.current.emit('stop-process', { projectId });
    setState(prev => ({ ...prev, status: 'idle' }));
    setTimeout(fetchRunningProjects, 500);
  };

  const installDependencies = () => {
    setState(prev => ({ ...prev, status: 'installing' }));
    if (state.stack === 'python') {
      runCommand('pip', ['install', '-r', 'requirements.txt'], true);
    } else {
      runCommand('npm', ['install'], true);
    }
  };

  const resetSession = async () => {
    if (!confirm('Are you sure you want to reset the WhatsApp session? This will log you out.')) return;
    try {
      const response = await fetch('/api/reset-session', {
        method: 'POST',
        headers: { 'x-project-id': projectId }
      });
      const data = await response.json();
      if (data.success) {
        addLog('SUCCESS: Session cleared. You can now re-pair the bot.');
      }
    } catch (err) {
      addLog(`ERROR: Reset failed: ${err}`);
    }
  };

  const clearLogs = () => {
    setState(prev => ({ ...prev, logs: [] }));
  };

  const toggleAltTunnel = () => {
    if (altTunnelUrl) {
      socketRef.current?.emit('stop-alt-tunnel', { projectId });
      setAltTunnelUrl(null);
      setAltTunnelPassword(null);
    } else {
      socketRef.current?.emit('start-alt-tunnel', { projectId });
    }
    setTimeout(fetchRunningProjects, 500);
  };

  const handleExport = async () => {
    if (state.files.length === 0) return;
    addLog('Preparing ZIP export...');
    await exportToZip(state.files, projectName);
    addLog('SUCCESS: Project exported as ZIP.');
  };

  const getStackIcon = () => {
    switch (state.stack) {
      case 'vite': return <Zap className="text-yellow-400" />;
      case 'node': return <Package className="text-emerald-400" />;
      case 'python': return <FileCode2 className="text-blue-400" />;
      default: return <Cpu className="text-zinc-400" />;
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6 font-sans selection:bg-emerald-500/30">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-8 border-b border-zinc-900">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-500 flex items-center justify-center text-zinc-950 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
              <Cpu size={28} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <input 
                  type="text" 
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="bg-transparent border-none p-0 text-2xl font-bold tracking-tight text-white focus:ring-0 focus:outline-none w-full"
                  placeholder="Project Name"
                />
              </div>
              <p className="text-zinc-500 text-sm">Real-world stack execution, auto-fix & global tunnel</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => {
                const win = window.open('', '_blank');
                if (win) {
                  win.document.write(`
                    <html>
                      <body style="font-family: sans-serif; background: #09090b; color: #e4e4e7; padding: 40px; line-height: 1.6;">
                        <h1 style="color: #10b981;">🚀 Como Hospedar seu Projeto</h1>
                        <p>Este aplicativo (Project Porter) é um <b>servidor full-stack</b> que gerencia outros processos. Por isso, ele tem requisitos específicos:</p>
                        
                        <h2 style="color: #3b82f6;">1. Render / Railway / Fly.io (Recomendado)</h2>
                        <p>Estes serviços suportam servidores Node.js persistentes. Use o arquivo <code>render.yaml</code> incluído na raiz.</p>
                        <ul>
                          <li>Conecte seu GitHub no Render.</li>
                          <li>O Render detectará o <code>render.yaml</code> e configurará tudo.</li>
                          <li>Lembre-se de adicionar sua <code>GEMINI_API_KEY</code> nas variáveis de ambiente do Render.</li>
                        </ul>

                        <h2 style="color: #f59e0b;">2. Netlify / Vercel (Apenas Frontend)</h2>
                        <p>O Netlify é excelente para sites estáticos, mas <b>não suporta</b> execução de comandos shell (como <code>npm install</code> ou <code>node</code>) em tempo real como este app faz.</p>
                        <ul>
                          <li>Você pode hospedar a interface (o site), mas as funções de "Run Project" não funcionarão sem um backend separado.</li>
                          <li>Use o <code>netlify.toml</code> para configurar o redirecionamento de rotas.</li>
                        </ul>

                        <h2 style="color: #ffffff;">3. GitHub</h2>
                        <p>Para mandar para o GitHub agora:</p>
                        <ol>
                          <li>Clique no ícone de <b>engrenagem (Settings)</b> no topo direito do AI Studio.</li>
                          <li>Selecione <b>"Export to GitHub"</b>.</li>
                        </ol>
                        
                        <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #27272a; border: none; color: white; border-radius: 8px; cursor: pointer;">Fechar</button>
                      </body>
                    </html>
                  `);
                }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 rounded-xl text-sm font-semibold transition-all"
            >
              <Github size={16} className="text-white" />
              Hospedar / GitHub
            </button>
            <button 
              onClick={() => {
                setShowProjectsTab(true);
                fetchAllProjects();
              }}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 rounded-xl text-sm font-semibold transition-all"
            >
              <FolderOpen size={16} className="text-blue-500" />
              Projects ({allProjects.length})
            </button>
            <button 
              onClick={() => {
                setShowRunningTab(true);
                fetchRunningProjects();
              }}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 rounded-xl text-sm font-semibold transition-all"
            >
              <Cpu size={16} className="text-emerald-500" />
              Running ({runningProjects.length})
            </button>
            <button 
              onClick={handleExport}
              disabled={state.files.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 bg-zinc-100 hover:bg-white text-zinc-950 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg active:scale-95"
            >
              <Download size={18} />
              Export ZIP
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Controls & Info */}
          <div className="lg:col-span-5 space-y-6">
            <section className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Project Setup</h2>
                {state.files.length > 0 && (
                  <span className="px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-500 text-[10px] font-bold uppercase">
                    Ready
                  </span>
                )}
              </div>

              {state.files.length === 0 ? (
                <FileUploader 
                  onFilesSelected={(files, rawFiles) => {
                    handleFilesSelected(files);
                    if (rawFiles) uploadFiles(rawFiles);
                  }} 
                  isProcessing={state.status !== 'idle' && state.status !== 'error'} 
                />
              ) : (
                <div className="space-y-4">
                  <div className="p-4 bg-zinc-950 rounded-xl border border-zinc-800 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-zinc-900 flex items-center justify-center">
                      {getStackIcon()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-zinc-500 uppercase font-bold tracking-tighter">Detected Stack</p>
                      <h3 className="text-lg font-semibold text-white truncate capitalize">{state.stack} Project</h3>
                    </div>
                    <button 
                      onClick={() => {
                        fetch('/api/clear', { headers: { 'x-project-id': projectId }, method: 'POST' });
                        setState({ files: [], stack: 'unknown', status: 'idle', logs: [] });
                        setPublicUrl(null);
                        setMainFile('');
                        setCustomCommand('');
                      }}
                      className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <RefreshCw size={18} />
                    </button>
                  </div>

                  <div className="space-y-3 p-4 bg-zinc-900/80 rounded-xl border border-zinc-800">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Entry File (Optional)</label>
                      <input 
                        type="text" 
                        value={mainFile}
                        onChange={(e) => setMainFile(e.target.value)}
                        placeholder="e.js, server.js, main.py..."
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-emerald-500/50 focus:outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Custom Command (Overrides all)</label>
                      <input 
                        type="text" 
                        value={customCommand}
                        onChange={(e) => setCustomCommand(e.target.value)}
                        placeholder="node index.js, python bot.py..."
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:ring-1 focus:ring-blue-500/50 focus:outline-none transition-all"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={installDependencies}
                      disabled={state.status !== 'idle'}
                      className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                    >
                      <Package size={16} />
                      Install Deps
                    </button>
                    {state.status === 'running' ? (
                      <button
                        onClick={stopProcess}
                        className="flex items-center justify-center gap-2 p-3 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-sm font-medium transition-all shadow-[0_0_15px_rgba(225,29,72,0.2)]"
                      >
                        <Square size={16} fill="currentColor" />
                        Stop Project
                      </button>
                    ) : (
                      <button
                        onClick={startProject}
                        disabled={state.status !== 'idle'}
                        className="flex items-center justify-center gap-2 p-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-medium transition-all disabled:opacity-50 shadow-[0_0_15px_rgba(16,185,129,0.2)]"
                      >
                        <Play size={16} fill="currentColor" />
                        Run Project
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={resetSession}
                      className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-sm font-medium transition-all"
                    >
                      <RefreshCw size={16} />
                      Reset Session
                    </button>
                    <button
                      onClick={clearLogs}
                      className="flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-sm font-medium transition-all"
                    >
                      <Trash2 size={16} />
                      Clear Logs
                    </button>
                    <button
                      onClick={async () => {
                        await fetch('/api/kill-all', { headers: { 'x-project-id': projectId }, method: 'POST' });
                        setState(prev => ({ ...prev, status: 'idle' }));
                        addLog('System: All project processes killed.', 'system');
                      }}
                      className="col-span-2 flex items-center justify-center gap-2 p-3 bg-rose-950/30 hover:bg-rose-900/50 text-rose-400 border border-rose-900/50 rounded-xl text-xs font-bold uppercase tracking-widest transition-all"
                    >
                      <Square size={14} fill="currentColor" />
                      Force Kill All Processes
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Tunnel Info */}
            <AnimatePresence>
              {(publicUrl || altTunnelUrl) && (
                <motion.section
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-emerald-400">
                      <Globe size={18} />
                      <h2 className="text-sm font-semibold uppercase tracking-wider">Public Tunnels Active</h2>
                    </div>
                    <button 
                      onClick={toggleAltTunnel}
                      className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border transition-all ${altTunnelUrl ? 'bg-rose-500/10 border-rose-500/30 text-rose-500' : 'bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20'}`}
                    >
                      {altTunnelUrl ? 'Stop Alt Tunnel' : '🚀 Start Alternative Global Tunnel'}
                    </button>
                  </div>

                  {publicUrl && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-zinc-500 uppercase font-bold">Local Preview (Proxy)</p>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => {
                              const iframe = document.querySelector('iframe[title="Local Preview"]') as HTMLIFrameElement;
                              if (iframe) iframe.src = iframe.src;
                            }}
                            className="p-1 text-zinc-500 hover:text-emerald-500 transition-colors"
                            title="Refresh Preview"
                          >
                            <RefreshCw size={12} />
                          </button>
                          <span className="text-[9px] text-zinc-600 italic">If you see 403, wait for project to start</span>
                        </div>
                      </div>
                      <div className="p-3 bg-zinc-950 rounded-lg border border-emerald-500/30 flex items-center justify-between">
                        <code className="text-xs text-emerald-300 truncate mr-2">{publicUrl}</code>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => window.open(publicUrl, '_blank')}
                            className="p-1.5 bg-emerald-500/10 text-emerald-500 rounded-md hover:bg-emerald-500 hover:text-zinc-950 transition-all"
                            title="Open in new tab"
                          >
                            <ExternalLink size={14} />
                          </button>
                        </div>
                      </div>
                      
                      {/* Iframe Preview */}
                      <div className="mt-4 rounded-xl border border-zinc-800 overflow-hidden bg-white h-[300px]">
                        <iframe 
                          src={publicUrl} 
                          className="w-full h-full border-none"
                          title="Local Preview"
                        />
                      </div>
                    </div>
                  )}

                  {altTunnelUrl && (
                    <div className="space-y-2">
                      <p className="text-[10px] text-zinc-500 uppercase font-bold">Alternative Tunnel (Localtunnel)</p>
                      <div className="p-3 bg-zinc-950 rounded-lg border border-blue-500/30 flex items-center justify-between">
                        <div className="flex flex-col min-w-0">
                          <code className="text-xs text-blue-300 truncate mr-2">{altTunnelUrl}</code>
                          {altTunnelPassword && (
                            <span className="text-[9px] text-zinc-500 mt-1">Password: <code className="text-blue-400 font-bold">{altTunnelPassword}</code></span>
                          )}
                        </div>
                        <a 
                          href={altTunnelUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-1.5 bg-blue-500 text-zinc-950 rounded-md hover:bg-blue-400 transition-colors"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    </div>
                  )}
                  
                  <p className="text-[10px] text-zinc-500 italic">
                    * These links are public and accessible from anywhere in the world.
                  </p>
                </motion.section>
              )}
            </AnimatePresence>

            {/* Features Info */}
            <section className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-xl space-y-2">
                <ShieldCheck size={20} className="text-emerald-500" />
                <h4 className="text-xs font-bold text-zinc-300">Auto-Fix</h4>
                <p className="text-[10px] text-zinc-500">Detects missing modules and installs them automatically.</p>
              </div>
              <div className="p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-xl space-y-2">
                <Globe size={20} className="text-blue-500" />
                <h4 className="text-xs font-bold text-zinc-300">Global Tunnel</h4>
                <p className="text-[10px] text-zinc-500">Bypasses localhost restrictions for remote access.</p>
              </div>
            </section>
          </div>

          {/* Right Column: Terminal & Files */}
          <div className="lg:col-span-7 space-y-6">
            <Terminal 
              logs={state.logs} 
              onClear={() => setState(prev => ({ ...prev, logs: [] }))} 
            />

            {state.files.length > 0 && (
              <section className="bg-zinc-900/50 border border-zinc-800 rounded-2xl overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/80">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">File Manifest</h3>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={checkProjectStatus}
                      className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                      title="Refresh Files"
                    >
                      <RefreshCw size={12} />
                    </button>
                    <span className="text-[10px] text-zinc-500 font-mono">{state.files.length} items</span>
                  </div>
                </div>
                <div className="max-h-[250px] overflow-y-auto p-2 space-y-1 custom-scrollbar">
                  {state.files.slice(0, 100).map((file, i) => (
                    <div 
                      key={i} 
                      onClick={() => file.type === 'file' && setEditingFile(file.path)}
                      className={`flex items-center gap-3 px-3 py-2 hover:bg-zinc-800/50 rounded-lg transition-colors group ${file.type === 'file' ? 'cursor-pointer' : ''}`}
                    >
                      {file.type === 'directory' ? (
                        <FolderOpen size={14} className="text-emerald-500/70 group-hover:text-emerald-400" />
                      ) : (
                        <FileCode2 size={14} className="text-zinc-500 group-hover:text-zinc-300" />
                      )}
                      <span className={`text-xs font-mono truncate ${file.type === 'directory' ? 'text-emerald-300/80' : 'text-zinc-400'}`}>
                        {file.path}
                      </span>
                      {file.type === 'file' && (
                        <span className="ml-auto text-[8px] font-bold text-zinc-600 uppercase opacity-0 group-hover:opacity-100 transition-opacity">Edit</span>
                      )}
                    </div>
                  ))}
                  {state.files.length > 100 && (
                    <div className="text-center py-2 text-[10px] text-zinc-600 italic">
                      ... and {state.files.length - 100} more items
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </main>

        <AnimatePresence>
          {editingFile && (
            <FileEditor 
              projectId={projectId}
              filePath={editingFile}
              onClose={() => setEditingFile(null)}
              onSaveSuccess={() => {
                addLog(`File saved: ${editingFile}`);
              }}
            />
          )}
        </AnimatePresence>

        {/* Footer */}
        <footer className="pt-8 border-t border-zinc-900 flex flex-col md:flex-row items-center justify-between gap-4 text-zinc-600 text-[10px] uppercase tracking-widest font-bold">
          <div className="flex items-center gap-6">
            <span>© 2026 Project Porter</span>
            <span className="flex items-center gap-1"><Zap size={10} /> Powered by AI Studio</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-emerald-500/80">System Status: Operational</span>
          </div>
        </footer>
      </div>

      <AnimatePresence>
        {showProjectsTab && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/50">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-500/10 rounded-lg">
                    <FolderOpen size={20} className="text-blue-500" />
                  </div>
                  <h2 className="text-lg font-bold text-white">Saved Projects</h2>
                </div>
                <button 
                  onClick={() => setShowProjectsTab(false)}
                  className="p-2 text-zinc-500 hover:text-white transition-colors"
                >
                  <Square size={20} />
                </button>
              </div>
              
              <div className="p-6 max-h-[400px] overflow-y-auto space-y-4 custom-scrollbar">
                {allProjects.length === 0 ? (
                  <div className="text-center py-12 space-y-3">
                    <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mx-auto text-zinc-600">
                      <Archive size={32} />
                    </div>
                    <p className="text-zinc-500 text-sm">No projects saved yet.</p>
                  </div>
                ) : (
                  allProjects.map((id) => (
                    <div key={id} className="p-4 bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-between group hover:border-blue-500/30 transition-all">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">{id}</span>
                          {id === projectId && (
                            <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-500 text-[8px] font-bold uppercase rounded">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-zinc-600 uppercase font-bold tracking-wider">Persistent Storage</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => switchProject(id)}
                          disabled={id === projectId}
                          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-all disabled:opacity-30"
                        >
                          Switch
                        </button>
                        {deletingProjectId === id ? (
                          <div className="flex items-center gap-1">
                            <button 
                              onClick={async () => {
                                await fetch('/api/clear', { headers: { 'x-project-id': id }, method: 'POST' });
                                fetchAllProjects();
                                setDeletingProjectId(null);
                                if (id === projectId) {
                                  const newId = `project-${Math.random().toString(36).substring(2, 11)}`;
                                  switchProject(newId);
                                }
                              }}
                              className="px-3 py-1 bg-rose-600 text-white text-[10px] font-bold rounded-lg transition-all hover:bg-rose-500"
                            >
                              Confirm
                            </button>
                            <button 
                              onClick={() => setDeletingProjectId(null)}
                              className="px-3 py-1 bg-zinc-800 text-zinc-400 text-[10px] font-bold rounded-lg transition-all hover:bg-zinc-700"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button 
                            onClick={() => setDeletingProjectId(id)}
                            className="p-2 text-zinc-600 hover:text-rose-500 transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              
              <div className="px-6 py-4 bg-zinc-950/50 border-t border-zinc-800 flex justify-between items-center">
                <button 
                  onClick={() => {
                    const newId = `project-${Math.random().toString(36).substring(2, 11)}`;
                    switchProject(newId);
                  }}
                  className="text-xs font-bold text-emerald-500 hover:text-emerald-400 transition-colors"
                >
                  + Create New Project
                </button>
                <button 
                  onClick={() => setShowProjectsTab(false)}
                  className="px-6 py-2 bg-zinc-100 hover:bg-white text-zinc-950 rounded-xl font-bold transition-all"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {showRunningTab && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/50">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <Cpu size={20} className="text-emerald-500" />
                  </div>
                  <h2 className="text-lg font-bold text-white">Running Projects</h2>
                </div>
                <button 
                  onClick={() => setShowRunningTab(false)}
                  className="p-2 text-zinc-500 hover:text-white transition-colors"
                >
                  <Square size={20} />
                </button>
              </div>
              
              <div className="p-6 max-h-[400px] overflow-y-auto space-y-4 custom-scrollbar">
                {runningProjects.length === 0 ? (
                  <div className="text-center py-12 space-y-3">
                    <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mx-auto text-zinc-600">
                      <Cpu size={32} />
                    </div>
                    <p className="text-zinc-500 text-sm">No projects currently running.</p>
                  </div>
                ) : (
                  runningProjects.map((proj) => (
                    <div key={proj.projectId} className="p-4 bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-between group hover:border-emerald-500/30 transition-all">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">{proj.projectId}</span>
                          {proj.projectId === projectId && (
                            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-500 text-[8px] font-bold uppercase rounded">Current</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-zinc-500 uppercase font-bold tracking-wider">
                          <span className="flex items-center gap-1">
                            <RefreshCw size={10} className="animate-spin text-emerald-500" />
                            Started {new Date(proj.startTime).toLocaleTimeString()}
                          </span>
                          {proj.hasTunnel && (
                            <span className="flex items-center gap-1 text-blue-400">
                              <Globe size={10} />
                              Tunnel Active
                            </span>
                          )}
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          socketRef.current?.emit('stop-process', { projectId: proj.projectId });
                          setTimeout(fetchRunningProjects, 500);
                        }}
                        className="p-2 bg-rose-500/10 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all opacity-0 group-hover:opacity-100"
                        title="Stop Project"
                      >
                        <Square size={16} fill="currentColor" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              
              <div className="px-6 py-4 bg-zinc-950/50 border-t border-zinc-800 flex justify-end">
                <button 
                  onClick={() => setShowRunningTab(false)}
                  className="px-6 py-2 bg-zinc-100 hover:bg-white text-zinc-950 rounded-xl font-bold transition-all"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
};

export default App;
