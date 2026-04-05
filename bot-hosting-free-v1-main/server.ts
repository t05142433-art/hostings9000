import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer as createHttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn, exec } from 'child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import net from 'net';
import treeKill from 'tree-kill';

const PORT = 3000;
const PROJECTS_DIR = path.join(process.cwd(), 'projects');

const STATE_FILE = path.join(process.cwd(), 'state.json');

// Track running processes and tunnels globally
const activeProjects = new Map<string, {
  process: any;
  tunnel: any;
  tunnelProxy: any;
  healthMonitor: any;
  startTime: number;
  port: number;
  tunnelProxyPort: number;
  lastHealthCheck: number;
  consecutiveFailures: number;
  logs: string[];
  command?: string;
  args?: string[];
  stack?: string;
}>();

function saveState() {
  try {
    const state = Array.from(activeProjects.entries()).map(([id, data]) => ({
      id,
      startTime: data.startTime,
      port: data.port,
      tunnelProxyPort: data.tunnelProxyPort,
      logs: data.logs.slice(-100), // Only save last 100 logs to keep state file small
      command: data.command,
      args: data.args,
      stack: data.stack,
      hasTunnel: !!data.tunnel
    }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

// Helper to check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '0.0.0.0');
  });
}

// Helper to find an available port
async function findAvailablePort(startPort: number, excludePorts: number[] = []): Promise<number> {
  let port = startPort;
  while (true) {
    if (!excludePorts.includes(port) && await isPortAvailable(port)) {
      return port;
    }
    port++;
    if (port > 65535) throw new Error('No available ports found');
  }
}

// Helper to get public IP for Localtunnel password
async function getPublicIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch (err) {
    return 'Unknown (Check server logs)';
  }
}

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// Helper to handle module errors
function handleModuleError(output: string, socket: any, stack: string, projectPath: string) {
  if (output.includes('ModuleNotFoundError') || output.includes('Cannot find module')) {
    const match = output.match(/No module named ['"]([^'"]+)['"]/) || output.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (match && match[1]) {
      const moduleName = match[1];
      socket.emit('log', `System: Missing module "${moduleName}" detected. Attempting auto-fix...`);
      // FIX: Added --break-system-packages to pip install for Render compatibility
      const installCmd = stack === 'python' ? `pip install ${moduleName} --break-system-packages` : `npm install ${moduleName}`;
      socket.emit('log', `System: Running ${installCmd}...`);
      exec(installCmd, { cwd: projectPath }, (err) => {
        if (err) {
          socket.emit('log', `ERROR: Failed to install ${moduleName}: ${err.message}`);
        } else {
          socket.emit('log', `SUCCESS: ${moduleName} installed. Please restart the project.`);
        }
      });
    }
  }

  if (output.includes('SyntaxError: Cannot use import statement outside a module')) {
    socket.emit('log', 'System: Syntax error detected! Attempting to fix by adding "type": "module" to package.json...');
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.type !== 'module') {
          pkg.type = 'module';
          pkg._justFixed = Date.now();
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
          socket.emit('log', 'SUCCESS: Added "type": "module" to package.json. Auto-restarting...');
        }
      } catch (e) {
        socket.emit('log', 'ERROR: Failed to update package.json automatically.');
      }
    } else {
      socket.emit('log', 'System: No package.json found. Creating one with "type": "module"...');
      const pkg = { name: 'auto-fixed-project', version: '1.0.0', type: 'module' };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      socket.emit('log', 'SUCCESS: Created package.json. Please restart.');
    }
  }

  if (output.includes('ReferenceError: require is not defined') && output.includes('in ES module scope')) {
    socket.emit('log', 'System: You are using "require" in an ES module. Attempting to fix by removing "type": "module" from package.json...');
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.type === 'module') {
          delete pkg.type;
          pkg._justFixed = Date.now();
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
          socket.emit('log', 'SUCCESS: Removed "type": "module" from package.json. Auto-restarting...');
        }
      } catch (e) {}
    }
  }
}

// Helper to auto-fix project files
async function autoFixProject(projectPath: string, socket: any) {
  try {
    const listFilesRecursive = (dir: string): string[] => {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== '.next') {
            results = results.concat(listFilesRecursive(fullPath));
          }
        } else {
          // Scan almost all text-based files
          const ext = path.extname(file).toLowerCase();
          const textExtensions = ['.js', '.ts', '.jsx', '.tsx', '.json', '.env', '.py', '.sh', '.yaml', '.yml', '.conf', '.config', '.txt'];
          if (textExtensions.includes(ext) || file === 'Dockerfile' || file === 'Procfile') {
            results.push(fullPath);
          }
        }
      });
      return results;
    };

    const files = listFilesRecursive(projectPath);
    socket.emit('log', `System: Scanning ${files.length} files for potential fixes...`);
    let fixedAny = false;

    // Check package.json for hardcoded ports in scripts
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        let pkgChanged = false;
        if (pkg.scripts) {
          const commonPorts = ['3000', '3001', '3333', '5000', '8000', '8080', '8888'];
          Object.keys(pkg.scripts).forEach(key => {
            let script = pkg.scripts[key];
            commonPorts.forEach(p => {
              // Replace port in scripts like "node app.js 3000" or "PORT=3000 node app.js"
              const portRegex = new RegExp(`\\b${p}\\b`, 'g');
              if (portRegex.test(script) && !script.includes('$PORT')) {
                socket.emit('log', `System: Auto-fixing hardcoded port ${p} in package.json script "${key}"...`);
                script = script.replace(portRegex, '$PORT');
                pkgChanged = true;
              }
            });
            // Vite specific: ensure --port $PORT is present if it's a vite command
            if (script.includes('vite') && !script.includes('--port')) {
              script = script.replace('vite', 'vite --port $PORT');
              pkgChanged = true;
            }
            pkg.scripts[key] = script;
          });
        }
        if (pkgChanged) {
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
          fixedAny = true;
        }
      } catch (e) {
        socket.emit('log', `System Warning: Failed to parse package.json for auto-fix: ${e.message}`);
      }
    }

    for (const filePath of files) {
      const file = path.basename(filePath);
      const ext = path.extname(file).toLowerCase();
      let content = fs.readFileSync(filePath, 'utf8');
      let originalContent = content;
      
      // Skip if file has // no-autofix
      if (content.includes('// no-autofix') || content.includes('# no-autofix')) {
        continue;
      }
      
      // Fix hardcoded ports (3000, 3001, 5000, 8080, etc)
      const commonPorts = ['3000', '3001', '3333', '5000', '8000', '8080', '8888'];
      let fileFixed = false;

      for (const p of commonPorts) {
        if (content.includes(p)) {
          if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
            // Replace listen(PORT...)
            const listenRegex = new RegExp(`listen\\(\\s*${p}\\b`, 'g');
            content = content.replace(listenRegex, `listen(process.env.PORT || ${p}`);
            
            // Replace .listen(PORT...)
            const dotListenRegex = new RegExp(`\\.listen\\(\\s*${p}\\b`, 'g');
            content = content.replace(dotListenRegex, `.listen(process.env.PORT || ${p}`);
            
            // Replace assignments like port = PORT, PORT = PORT, port: PORT, PORT: PORT
            const assignRegex = new RegExp(`\\b(port|PORT)\\s*[:=]\\s*${p}\\b`, 'g');
            content = content.replace(assignRegex, (match, p1) => {
              const separator = match.includes(':') ? ':' : '=';
              return `${p1} ${separator} process.env.PORT || ${p}`;
            });
            
            // Replace template literals like :PORT
            const colonRegex = new RegExp(`\`([^:\`]*):${p}([^:\`]*)\``, 'g');
            content = content.replace(colonRegex, `\`$1:\${process.env.PORT || ${p}}$2\``);

            // Replace hardcoded strings like "3000" or '3000'
            const quoteRegex = new RegExp(`(["'])${p}\\1`, 'g');
            content = content.replace(quoteRegex, (match, quote) => {
              // If it's just the port number in quotes, it's likely a config or listen call
              return `process.env.PORT || ${quote}${p}${quote}`;
            });
          } else if (ext === '.py') {
            // Python: app.run(port=3000) or port: 3000 or port = 3000
            const pyRegex = new RegExp(`\\b(port|PORT)\\s*[:=]\\s*${p}\\b`, 'g');
            content = content.replace(pyRegex, (match, p1) => {
              const separator = match.includes(':') ? ':' : '=';
              return `${p1}${separator}int(os.getenv('PORT', ${p}))`;
            });
            
            // Ensure os is imported if we added os.getenv
            if (content.includes('os.getenv') && !content.includes('import os')) {
              content = "import os\n" + content;
            }
          } else if (ext === '.env') {
            // .env: PORT=3000
            const envRegex = new RegExp(`^PORT\\s*=\\s*${p}\\b`, 'gm');
            if (envRegex.test(content)) {
              socket.emit('log', `System: Overriding PORT in .env file...`);
              content = content.replace(envRegex, `# PORT=${p} (Overridden by system)`);
            }
          } else if (ext === '.json' && file !== 'package.json') {
            // Generic JSON: "port": 3000
            const jsonRegex = new RegExp(`"(port|PORT)"\\s*:\\s*${p}\\b`, 'g');
            content = content.replace(jsonRegex, `"$1": 0`); // Set to 0 to let system pick if possible
          }

          if (content !== originalContent) {
            fileFixed = true;
            socket.emit('log', `System: Auto-fixing potential hardcoded port ${p} in ${file}...`);
          }
        }
      }

      // Fix Vite HMR port conflict if vite.config is found
      if (file.includes('vite.config')) {
        if (!content.includes('hmr') || !content.includes('port')) {
          socket.emit('log', `System: Optimizing Vite HMR configuration in ${file}...`);
          // Try to inject hmr: { port: 0 } to avoid conflicts
          if (content.includes('server: {')) {
            content = content.replace('server: {', 'server: { hmr: { port: 0 },');
          } else if (content.includes('defineConfig({')) {
            content = content.replace('defineConfig({', 'defineConfig({ server: { hmr: { port: 0 } },');
          } else if (content.includes('export default {')) {
            content = content.replace('export default {', 'export default { server: { hmr: { port: 0 } },');
          }
          fs.writeFileSync(filePath, content);
          fixedAny = true;
        }
      }

      if (fileFixed) {
        fs.writeFileSync(filePath, content);
        fixedAny = true;
      }

      // Fix missing express import if used but not imported
      if (content.includes('express()') && !content.includes('require(\'express\')') && !content.includes('from \'express\'')) {
         socket.emit('log', `System: Missing express import detected in ${file}. Adding it...`);
         const isModule = fs.existsSync(path.join(projectPath, 'package.json')) && 
                          JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')).type === 'module';
         
         if (isModule) {
           content = "import express from 'express';\n" + content;
         } else {
           content = "const express = require('express');\n" + content;
         }
         fs.writeFileSync(filePath, content);
         fixedAny = true;
      }

      // WhatsApp bot specific fix: ensure headless and no-sandbox
      if (content.includes('whatsapp-web.js') || content.includes('puppeteer')) {
        if (!content.includes('--no-sandbox')) {
          socket.emit('log', `System: WhatsApp bot detected in ${file}. Adding --no-sandbox flag for Linux compatibility...`);
          content = content.replace(/puppeteer\.launch\(\{/g, 'puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"],');
          content = content.replace(/new Client\(\{/g, 'new Client({ puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },');
          fs.writeFileSync(filePath, content);
          fixedAny = true;
        }
        
        if (content.includes('qrcode-terminal') && !content.includes('require(\'qrcode-terminal\')') && !content.includes('from \'qrcode-terminal\'')) {
          socket.emit('log', `System: Missing qrcode-terminal import detected in ${file}. Adding it...`);
          const isModule = fs.existsSync(path.join(projectPath, 'package.json')) && 
                           JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')).type === 'module';
          if (isModule) {
            content = "import qrcode from 'qrcode-terminal';\n" + content;
          } else {
            content = "const qrcode = require('qrcode-terminal');\n" + content;
          }
          fs.writeFileSync(filePath, content);
          fixedAny = true;
        }
      }
    }
    if (fixedAny) {
      socket.emit('log', 'System: Auto-fix completed for some files. Retrying execution...');
    }
  } catch (err: any) {
    socket.emit('log', `System Warning: Auto-fix failed: ${err.message}`);
  }
}

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: '*' }
  });

  app.use(cors());
  app.use(express.json());

  // Multer for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const projectId = req.headers['x-project-id'] as string || 'default';
      const projectPath = path.join(PROJECTS_DIR, projectId);
      const filePath = path.join(projectPath, path.dirname(file.originalname));
      
      if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
      }
      cb(null, filePath);
    },
    filename: (req, file, cb) => {
      cb(null, path.basename(file.originalname));
    }
  });

  const upload = multer({ storage });

  // API: Upload files
  app.post('/api/upload', upload.array('files'), (req, res) => {
    res.json({ success: true, message: 'Files uploaded successfully' });
  });

  // API: List all projects in the projects directory
  app.get('/api/projects', (req, res) => {
    try {
      const projects = fs.readdirSync(PROJECTS_DIR).filter(file => {
        return fs.statSync(path.join(PROJECTS_DIR, file)).isDirectory();
      });
      res.json(projects);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Get running projects
  app.get('/api/running-projects', (req, res) => {
    const running = Array.from(activeProjects.entries()).map(([id, data]) => ({
      projectId: id,
      startTime: data.startTime,
      hasTunnel: !!data.tunnel
    }));
    res.json(running);
  });

  // API: Get project info
  app.get('/api/project-info', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    if (!projectId) return res.status(400).json({ error: 'Missing project ID' });
    
    const projectPath = path.join(PROJECTS_DIR, projectId);
    if (!fs.existsSync(projectPath)) {
      return res.json({ exists: false });
    }

    // List files recursively (excluding node_modules for speed, but user can toggle)
    const listFiles = (dir: string, baseDir: string): string[] => {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          if (file !== 'node_modules' && file !== '.git') {
            results = results.concat(listFiles(fullPath, baseDir));
          } else {
            // Just add the directory itself
            results.push(path.relative(baseDir, fullPath) + '/');
          }
        } else {
          results.push(path.relative(baseDir, fullPath));
        }
      });
      return results;
    };

    const files = listFiles(projectPath, projectPath);
    res.json({ exists: true, files });
  });

  // API: Get file content
  app.get('/api/file-content', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    const filePath = req.query.path as string;
    if (!projectId || !filePath) return res.status(400).json({ error: 'Missing project ID or file path' });
    
    const fullPath = path.join(PROJECTS_DIR, projectId, filePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Save file content
  app.post('/api/save-file', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    const { path: filePath, content } = req.body;
    if (!projectId || !filePath) return res.status(400).json({ error: 'Missing project ID or file path' });
    
    const fullPath = path.join(PROJECTS_DIR, projectId, filePath);
    try {
      fs.writeFileSync(fullPath, content, 'utf8');
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Reset session
  app.post('/api/reset-session', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    if (!projectId) return res.status(400).json({ error: 'Missing project ID' });
    
    const sessionPath = path.join(PROJECTS_DIR, projectId, 'session');
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        res.json({ success: true, message: 'Session cleared successfully' });
      } else {
        res.json({ success: true, message: 'No session found to clear' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Clear project
  app.post('/api/clear', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    if (projectId) {
      const project = activeProjects.get(projectId);
      if (project?.process) {
        try {
          treeKill(project.process.pid, 'SIGKILL');
        } catch (e) {}
        project.process = null;
      }
      activeProjects.delete(projectId);
      saveState();

      const projectPath = path.join(PROJECTS_DIR, projectId);
      if (fs.existsSync(projectPath)) {
        try {
          fs.rmSync(projectPath, { recursive: true, force: true });
        } catch (e) {
          console.error(`Failed to delete project folder ${projectId}:`, e);
        }
      }
    }
    res.json({ success: true });
  });

  app.get('/api/project-status', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    if (!projectId) return res.status(400).json({ error: 'Project ID required' });

    const project = activeProjects.get(projectId);
    if (project) {
      res.json({
        running: !!project.process,
        startTime: project.startTime,
        hasTunnel: !!project.tunnel,
        tunnelUrl: project.tunnel?.url || null,
        logs: project.logs || []
      });
    } else {
      res.json({ running: false, logs: [] });
    }
  });

  app.post('/api/kill-all', (req, res) => {
    const projectId = req.headers['x-project-id'] as string;
    if (!projectId) return res.status(400).json({ error: 'Project ID required' });

    const project = activeProjects.get(projectId);
    if (project?.process) {
      treeKill(project.process.pid, 'SIGKILL', (err) => {
        if (err) console.error('Failed to kill process tree:', err);
        project.process = null;
        saveState();
        res.json({ success: true });
      });
    } else {
      res.json({ success: true, message: 'No active process found' });
    }
  });

  async function startAltTunnel(socket: any, projectId: string) {
  const existing = activeProjects.get(projectId);
  if (!existing) {
    socket.emit('log', 'ERROR: Project not found.');
    return;
  }

  // 1. Assign a port for the Tunnel Proxy if not already done
  if (!existing.tunnelProxyPort) {
    try {
      const usedProxyPorts = Array.from(activeProjects.values())
        .filter(p => p.tunnelProxyPort !== 0)
        .map(p => p.tunnelProxyPort);
      existing.tunnelProxyPort = await findAvailablePort(4001, usedProxyPorts);
      activeProjects.set(projectId, existing);
    } catch (err: any) {
      socket.emit('log', `ERROR: Failed to find port for tunnel proxy: ${err.message}`);
      return;
    }
  }

  const getStatusPage = (title: string, message: string, color: string, subMessage: string, autoRefresh: boolean = true) => {
    const isOffline = title.includes('Offline');
    const themeColor = isOffline ? '#eab308' : color; // Use yellow for offline/maintenance
    const icon = isOffline ? '🚧' : '⏳';
    
    return `
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Outfit', sans-serif; background: #09090b; overflow: hidden; }
          .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
          .card-3d { transform-style: preserve-3d; transition: transform 0.5s ease; perspective: 1000px; }
          .card-3d:hover { transform: rotateY(8deg) rotateX(4deg) scale(1.02); }
          .glow { box-shadow: 0 0 50px ${themeColor}22; }
          @keyframes float { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-15px) rotate(2deg); } }
          .float { animation: float 5s ease-in-out infinite; }
          .bg-gradient { background: radial-gradient(circle at 50% 50%, ${themeColor}11 0%, transparent 70%); }
          .construction-stripe { background: repeating-linear-gradient(45deg, #eab308, #eab308 10px, #000 10px, #000 20px); height: 6px; width: 100%; }
        </style>
      </head>
      <body class="flex items-center justify-center min-h-screen p-6">
        <div class="absolute inset-0 bg-gradient"></div>
        
        <div class="card-3d glass glow p-10 rounded-[2.5rem] max-w-md w-full text-center relative z-10 float border-t-4" style="border-color: ${themeColor}">
          ${isOffline ? '<div class="construction-stripe absolute top-0 left-0 rounded-t-[2.5rem]"></div>' : ''}
          ${isOffline ? '<div class="absolute -top-4 -right-4 bg-amber-500 text-black px-4 py-1 rounded-full font-black text-[10px] rotate-12 shadow-xl z-20 border-2 border-black tracking-widest">MANUTENÇÃO</div>' : ''}
          
          <div class="w-28 h-28 mx-auto mb-8 rounded-[2rem] flex items-center justify-center text-6xl shadow-2xl transform -rotate-6" style="background: ${themeColor}15; color: ${themeColor}; border: 2px solid ${themeColor}30;">
            ${icon}
          </div>
          
          <h1 class="text-4xl font-black text-white mb-4 tracking-tighter uppercase">${title}</h1>
          <p class="text-zinc-200 text-xl mb-3 font-bold">${message}</p>
          <p class="text-zinc-400 text-sm mb-10 leading-relaxed font-medium px-4">${subMessage}</p>
          
          <div class="space-y-4">
            <div class="flex flex-col gap-3">
              <a href="https://wa.me/14389423427?text=Olá Thayson! 🚀 Vi que o link do seu bot está desabilitado ou fora do ar no momento. 🛠️ Gostaria de saber o que aconteceu e como posso ajudar a trazer o projeto de volta! ⚡" target="_blank" class="w-full py-5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-black text-lg transition-all transform active:scale-95 flex items-center justify-center gap-3 shadow-lg shadow-emerald-900/20">
                <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.414 0 .018 5.394 0 12.03c0 2.12.54 4.19 1.563 6.04L0 24l6.15-1.612a11.77 11.77 0 005.891 1.569h.005c6.636 0 12.032-5.395 12.035-12.031a11.762 11.762 0 00-3.418-8.525z"/></svg>
                <span>Falar com Thayson</span>
              </a>
              <a href="https://www.instagram.com/7p_thayson/" target="_blank" class="w-full py-4 bg-zinc-100 hover:bg-white text-zinc-950 rounded-2xl font-bold transition-all transform active:scale-95 flex items-center justify-center gap-2">
                <span>Seguir no Instagram</span>
              </a>
            </div>
            
            ${autoRefresh ? `
              <div class="pt-6 border-t border-zinc-800">
                <div class="flex items-center justify-center gap-2 mb-2">
                  <div class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></div>
                  <p class="text-[10px] text-zinc-500 uppercase tracking-[0.2em] font-black">Recarregando em 5s</p>
                </div>
                <script>setTimeout(() => window.location.reload(), 5000);</script>
              </div>
            ` : `
              <div class="pt-6 border-t border-zinc-800">
                <p class="text-[10px] text-zinc-600 uppercase tracking-[0.2em] font-black">Link Temporariamente Indisponível</p>
              </div>
            `}
          </div>
        </div>
        
        <div class="fixed bottom-8 left-1/2 -translate-x-1/2 text-zinc-800 text-[10px] uppercase tracking-[0.4em] font-black">
          Project Porter System • 2026
        </div>
      </body>
    </html>
  `;
  };

  // 2. Start/Restart the Tunnel Proxy Server
  if (!existing.tunnelProxy) {
    const tunnelProxyApp = express();
    const tunnelProxyServer = createHttpServer(tunnelProxyApp);
    
    tunnelProxyApp.use((req, res, next) => {
      const project = activeProjects.get(projectId);
      if (project?.process && project.port) {
        createProxyMiddleware({
          target: `http://localhost:${project.port}`,
          changeOrigin: true,
          ws: true,
          on: {
            error: (err, req, res) => {
              if (res && 'writeHead' in res) {
                res.writeHead(503, { 'Content-Type': 'text/html' });
                res.end(getStatusPage(
                  '⚠️ Projeto Iniciando',
                  'O servidor do seu bot ainda não respondeu.',
                  '#f59e0b',
                  'O link está ativo, mas o processo interno está carregando ou em loop. Aguarde alguns segundos.'
                ));
              }
            }
          }
        })(req, res, next);
      } else {
        res.status(503).send(getStatusPage(
          '🚧 Link em Manutenção',
          'O projeto está temporariamente fora do ar.',
          '#eab308',
          'Este bot foi desabilitado ou está passando por uma atualização no momento. Tente novamente mais tarde ou entre em contato com o proprietário.',
          false
        ));
      }
    });

    tunnelProxyServer.listen(existing.tunnelProxyPort, '0.0.0.0');
    existing.tunnelProxy = tunnelProxyServer;
    activeProjects.set(projectId, existing);
  }

  const logToProject = (msg: string) => {
    const p = activeProjects.get(projectId);
    if (p) {
      p.logs.push(msg);
      if (p.logs.length > 1000) p.logs.shift();
      if (socket && socket.connected) {
        socket.emit('log', msg);
      }
    }
  };

  logToProject('System: Initializing Stable Global Tunnel (via Localtunnel)...');
  
  if (existing.tunnel) {
    try { existing.tunnel.close(); } catch(e) {}
    logToProject('System: Refreshing tunnel connection...');
  }

  try {
    const publicIp = await getPublicIp();
    logToProject(`System: Localtunnel Password (IP): ${publicIp}`);
    
    const { default: localtunnel } = await import('localtunnel');
    const subdomain = projectId.replace(/[^a-z0-9]/g, '').substring(0, 20);
    
    const tunnel = await localtunnel({ 
      port: existing.tunnelProxyPort,
      subdomain: subdomain
    });
    
    existing.tunnel = tunnel;
    existing.consecutiveFailures = 0;
    activeProjects.set(projectId, existing);
    saveState();

    if (socket && socket.connected) {
      socket.emit('alt-tunnel-ready', { url: tunnel.url, password: publicIp });
    }
    logToProject(`SUCCESS: Stable Tunnel Ready: ${tunnel.url}`);
    logToProject(`System: Health monitor active. Checking link status every 15s.`);

    // --- HEALTH MONITOR LOGIC ---
    if (existing.healthMonitor) clearInterval(existing.healthMonitor);
    
    existing.healthMonitor = setInterval(async () => {
      const project = activeProjects.get(projectId);
      if (!project || !project.tunnel) return;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(project.tunnel.url, { 
          signal: controller.signal,
          headers: { 'User-Agent': 'ProjectPorter-HealthMonitor/1.0' }
        });
        const body = await response.text();
        clearTimeout(timeoutId);

        const isOfflinePage = 
          body.includes('🔴 Bot Offline') || 
          body.includes('⚠️ Projeto Iniciando') || 
          body.includes('tunnel not found') || 
          body.includes('localtunnel.me') ||
          body.includes('Tunnel not found') ||
          body.includes('504 Gateway Time-out') ||
          body.includes('502 Bad Gateway') ||
          body.includes('Tunnel unavailable') ||
          body.includes('Service Unavailable');

        if (response.status >= 500 || isOfflinePage || response.status === 404) {
          project.consecutiveFailures = (project.consecutiveFailures || 0) + 1;
          
          if (project.consecutiveFailures >= 2) {
            if (isOfflinePage || response.status === 503 || response.status === 504) {
              logToProject(`System Monitor: Project "${projectId}" appears offline or unreachable at ${project.tunnel.url}. Attempting to restart project process...`);
              executeProjectCommand(socket, projectId, project.command || 'npm', project.args || ['start'], project.stack || 'node', true);
            } else {
              logToProject(`System Monitor: Tunnel URL returning ${response.status}. Restarting tunnel...`);
              startAltTunnel(socket, projectId);
            }
            project.consecutiveFailures = 0;
          }
        } else {
          project.consecutiveFailures = 0;
        }
      } catch (err: any) {
        project.consecutiveFailures = (project.consecutiveFailures || 0) + 1;
        if (project.consecutiveFailures >= 2) {
          logToProject(`System Monitor: Cannot reach tunnel URL. Error: ${err.message}. Restarting tunnel...`);
          startAltTunnel(socket, projectId);
          project.consecutiveFailures = 0;
        }
      }
    }, 15000);

    tunnel.on('close', () => {
      const current = activeProjects.get(projectId);
      if (current?.tunnel === tunnel) {
        logToProject('System: Tunnel connection dropped. Attempting auto-reconnect in 5s...');
        setTimeout(() => {
          startAltTunnel(socket, projectId);
        }, 5000);
      }
    });
  } catch (err: any) {
    logToProject(`ERROR: Failed to start tunnel: ${err.message}`);
  }
}

async function resumeProjects() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const proj of state) {
        console.log(`Resuming project ${proj.id}...`);
        
        activeProjects.set(proj.id, {
          process: null,
          tunnel: null,
          tunnelProxy: null,
          healthMonitor: null,
          startTime: proj.startTime,
          port: proj.port,
          tunnelProxyPort: proj.tunnelProxyPort,
          lastHealthCheck: 0,
          consecutiveFailures: 0,
          logs: proj.logs || [],
          command: proj.command,
          args: proj.args,
          stack: proj.stack
        });

        const mockSocket = {
          emit: (event: string, data: any) => {
            // console.log(`[RESUME ${proj.id}] ${event}:`, data);
            if (event === 'log') {
              const p = activeProjects.get(proj.id);
              if (p) {
                p.logs.push(data);
                if (p.logs.length > 1000) p.logs.shift();
              }
            }
          }
        };

        if (proj.command) {
          await executeProjectCommand(mockSocket, proj.id, proj.command, proj.args, proj.stack || 'node');
        }
        
        if (proj.hasTunnel) {
          await startAltTunnel(mockSocket, proj.id);
        }
      }
    } catch (e) {
      console.error('Failed to resume projects:', e);
    }
  }
}

// Socket: Command Execution
  // Internal function to run a project command
async function executeProjectCommand(socket: any, projectId: string, command: string, args: string[] = [], stack: string = 'node', autoStart: boolean = false) {
  const baseProjectPath = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(baseProjectPath)) {
    socket.emit('log', `ERROR: Project directory not found at ${baseProjectPath}`);
    return;
  }

  // Find the project root (where package.json or requirements.txt is)
  let projectPath = baseProjectPath;
  const findRoot = (dir: string): string | null => {
    try {
      const files = fs.readdirSync(dir);
      if (files.includes('package.json') || files.includes('requirements.txt') || files.includes('main.py') || files.includes('app.py')) {
        return dir;
      }
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules' && file !== '.git') {
          const root = findRoot(fullPath);
          if (root) return root;
        }
      }
    } catch (e) {}
    return null;
  };

  const detectedRoot = findRoot(baseProjectPath);
  if (detectedRoot) {
    projectPath = detectedRoot;
  }
  socket.emit('log', `System: Detected project root at ${path.relative(baseProjectPath, projectPath) || './'}`);
  socket.emit('log', `System: Full project path: ${projectPath}`);

  // Auto-fix common issues before running
  await autoFixProject(projectPath, socket);

  // Kill existing process for this project
  const existing = activeProjects.get(projectId);
  if (existing && existing.process) {
    socket.emit('log', 'System: Stopping existing project process...');
    treeKill(existing.process.pid, 'SIGKILL');
  }

  // Find an available port
  const usedPorts = Array.from(activeProjects.values())
    .filter(p => p.process !== null)
    .map(p => p.port);
  
  let projectPort = 3001;
  try {
    projectPort = await findAvailablePort(3001, usedPorts);
    socket.emit('log', `System: Using port ${projectPort} for this project.`);
  } catch (err: any) {
    socket.emit('log', `ERROR: ${err.message}`);
    return;
  }

  // Check for hardcoded port 3000 in project files
  try {
    const files = fs.readdirSync(projectPath);
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.py')) {
        const content = fs.readFileSync(path.join(projectPath, file), 'utf8');
        if (content.includes('3000') && !content.includes('process.env.PORT')) {
          socket.emit('log', `System Warning: File ${file} seems to hardcode port 3000. This will conflict with the main server. Please use process.env.PORT instead.`);
        }
      }
    }
  } catch (e) {}

  // If command is 'node' and file is '.ts', use 'tsx'
  let finalCommand = command;
  if (command === 'node' && args[0] && args[0].endsWith('.ts')) {
    finalCommand = 'npx tsx';
    socket.emit('log', 'System: TypeScript file detected. Using tsx to run.');
  }

  socket.emit('log', `Running: ${finalCommand} ${args.join(' ')}`);

  try {
    const child = spawn(finalCommand, args, {
      cwd: projectPath,
      shell: true,
      env: { 
        ...process.env, 
        PORT: projectPort.toString(),
        NODE_ENV: 'development',
        PATH: `${process.env.PATH}:/usr/local/bin:/usr/bin:/bin:/usr/local/git/bin`
      }
    });

    const current = activeProjects.get(projectId) || { 
      process: null, 
      tunnel: null, 
      tunnelProxy: null,
      healthMonitor: null,
      startTime: Date.now(), 
      port: projectPort,
      tunnelProxyPort: 0,
      lastHealthCheck: 0,
      consecutiveFailures: 0,
      logs: []
    };
    
    activeProjects.set(projectId, { 
      ...current, 
      process: child, 
      startTime: Date.now(), 
      port: projectPort,
      command,
      args,
      stack
    });
    saveState();

    child.stdout.on('data', (data) => {
      const output = data.toString();
      const project = activeProjects.get(projectId);
      if (project) {
        project.logs.push(output);
        if (project.logs.length > 1000) project.logs.shift();
      }
      socket.emit('log', output);
      handleModuleError(output, socket, stack, projectPath);
      if (output.includes('Error: Cannot find module')) {
        const match = output.match(/Cannot find module ['"]\.\/([^'"]+)['"]/);
        if (match && match[1]) {
          socket.emit('log', `System: Local module "${match[1]}" not found. This might mean the entry point is incorrect.`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      const project = activeProjects.get(projectId);
      if (project) {
        project.logs.push(`ERROR: ${errorMsg}`);
        if (project.logs.length > 1000) project.logs.shift();
      }
      socket.emit('log', `ERROR: ${errorMsg}`);
      handleModuleError(errorMsg, socket, stack, projectPath);
      if (errorMsg.includes('Error: Cannot find module') && !errorMsg.includes('node_modules')) {
        socket.emit('log', 'System: Local module import failed. Checking if the file exists in a different directory...');
      }
      if (errorMsg.includes('spawn git ENOENT') || errorMsg.includes('git error enoent')) {
        socket.emit('log', 'System: Git is not installed or not in PATH. NPM cannot install dependencies that require Git. Please check your package.json for git-based dependencies.');
      }
      if (errorMsg.includes('EADDRINUSE')) {
        socket.emit('log', `System: Port conflict detected! The application is trying to use a port that is already taken. Ensure your code uses process.env.PORT instead of a hardcoded value.`);
      }
    });

    child.on('close', (code) => {
      socket.emit('log', `Process exited with code ${code}`);
      const project = activeProjects.get(projectId);
      if (project && project.process === child) {
        activeProjects.set(projectId, { ...project, process: null });
        saveState();
      }
      if (code === 0) {
        socket.emit('command-success', { command, autoStart });
      } else {
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg._justFixed && pkg._justFixed > Date.now() - 5000) {
              socket.emit('log', 'System: A fix was recently applied. Retrying execution in 2 seconds...');
              delete pkg._justFixed;
              fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
              setTimeout(() => {
                executeProjectCommand(socket, projectId, command, args, stack, autoStart);
              }, 2000);
            }
          } catch (e) {}
        }
      }
    });

    // Check if port is listening after a few seconds (only for start commands)
    const isStartCommand = command === 'node' || (command === 'npm' && args.includes('start')) || command === 'python' || (command === 'npm' && args.includes('run') && (args.includes('dev') || args.includes('serve')));
    
    if (isStartCommand) {
      setTimeout(() => {
        if (child.exitCode !== null) return; // Process already exited
        exec(`netstat -tuln | grep :${projectPort}`, (err, stdout) => {
          if (!err && stdout.includes(`:${projectPort}`)) {
            socket.emit('log', `SUCCESS: Project is now listening on port ${projectPort}. Localhost preview should be ready.`);
          } else if (child.exitCode === null) {
            socket.emit('log', `System: Project started but not yet listening on port ${projectPort}. Waiting...`);
          }
        });
      }, 5000);
    }
  } catch (err: any) {
    socket.emit('log', `System Error: Failed to start process: ${err.message}`);
  }
}

io.on('connection', (socket) => {
    socket.on('install-deps', ({ projectId, stack }: { projectId: string, stack: string }) => {
      const projectPath = path.join(PROJECTS_DIR, projectId);
      if (!fs.existsSync(projectPath)) {
        socket.emit('log', 'ERROR: Project directory not found.');
        return;
      }

      const command = stack === 'python' ? 'pip' : 'npm';
      // FIX: Added --break-system-packages for Render/Python environment
      const args = stack === 'python' ? ['install', '-r', 'requirements.txt', '--break-system-packages'] : ['install'];
      
      socket.emit('log', `System: Starting installation: ${command} ${args.join(' ')}...`);
      
      const child = spawn(command, args, { 
        cwd: projectPath, 
        shell: true,
        env: {
          ...process.env,
          PATH: process.env.PATH + ':/usr/local/bin:/usr/bin:/bin:/usr/local/git/bin'
        }
      });

      child.stdout.on('data', (data) => socket.emit('log', data.toString()));
      child.stderr.on('data', (data) => {
        const errorMsg = data.toString();
        socket.emit('log', `ERROR: ${errorMsg}`);
        if (errorMsg.includes('spawn git ENOENT') || errorMsg.includes('git error enoent')) {
          socket.emit('log', 'System: Git is not installed or not in PATH. NPM cannot install dependencies that require Git.');
        }
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          socket.emit('log', 'SUCCESS: Dependencies installed successfully!');
        } else {
          socket.emit('log', `ERROR: Installation failed with code ${code}.`);
        }
      });
    });

    socket.on('join-project', ({ projectId }: { projectId: string }) => {
      const project = activeProjects.get(projectId);
      if (project && project.logs) {
        // Send existing logs to the newly connected client
        project.logs.forEach(log => socket.emit('log', log));
        if (project.tunnel) {
          socket.emit('alt-tunnel-ready', { url: project.tunnel.url, password: '' }); // Password might be missing but URL is key
        }
      }
    });

    socket.on('run-command', async ({ command, args, projectId, stack, autoStart }: { command: string, args: string[], projectId: string, stack: string, autoStart?: boolean }) => {
      await executeProjectCommand(socket, projectId, command, args, stack, autoStart);
    });

    socket.on('retry-command', async ({ command, args, projectId, stack, autoStart }: { command: string, args: string[], projectId: string, stack: string, autoStart?: boolean }) => {
      await executeProjectCommand(socket, projectId, command, args, stack, autoStart);
    });

    socket.on('start-alt-tunnel', async ({ projectId }: { projectId: string }) => {
      await startAltTunnel(socket, projectId);
    });

    socket.on('stop-alt-tunnel', ({ projectId }: { projectId: string }) => {
      const current = activeProjects.get(projectId);
      if (current) {
        if (current.tunnel) try { current.tunnel.close(); } catch(e) {}
        if (current.tunnelProxy) try { current.tunnelProxy.close(); } catch(e) {}
        if (current.healthMonitor) clearInterval(current.healthMonitor);
        current.tunnel = null;
        current.tunnelProxy = null;
        current.healthMonitor = null;
        activeProjects.set(projectId, current);
        saveState();
      }
      socket.emit('alt-tunnel-ready', null);
    });

    socket.on('stop-process', ({ projectId }: { projectId: string }) => {
      const current = activeProjects.get(projectId);
      if (current?.process) {
        treeKill(current.process.pid, 'SIGKILL');
        socket.emit('log', 'Process terminated by user.');
        current.process = null;
        saveState();
      }
    });
  });

  // Proxy for the "Public Tunnel"
  // Routes /p/:projectId/* to localhost:PORT
  app.use('/p/:projectId', (req, res, next) => {
    const projectId = req.params.projectId;
    const project = activeProjects.get(projectId);
    
    if (!project || !project.port) {
      return res.status(404).send('Project not found or not running.');
    }

    const target = `http://localhost:${project.port}`;
    
    createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: (path) => path.replace(/^\/p\/[^/]+/, ''),
      ws: true,
      on: {
        error: (err, req, res) => {
          if (res && 'writeHead' in res) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Tunnel Error: Project server is not running or not listening on port ${project.port}. Check your terminal logs for errors.`);
          } else if (res && 'end' in res) {
            (res as any).end();
          }
        }
      }
    })(req, res, next);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    // Check for git
    exec('which git || find /usr -name git -type f -executable 2>/dev/null | head -n 1', (err, stdout) => {
      if (!err && stdout.trim()) {
        console.log(`Git found at: ${stdout.trim()}`);
      } else {
        console.warn('WARNING: Git not found. NPM dependencies requiring git may fail.');
      }
    });

    // Cleanup port 3001 on start
    exec('fuser -k 3001/tcp || (lsof -t -i:3001 | xargs kill -9) || true', () => {
      console.log('Cleaned up port 3001');
    });

    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Resume projects on startup
  await resumeProjects();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
