export type StackType = 'vite' | 'node' | 'python' | 'unknown';

export interface ProjectFile {
  name: string;
  path: string;
  content: string | ArrayBuffer;
  type: string;
}

export interface Project {
  id: string;
  name: string;
  stack: StackType;
  status: 'idle' | 'running' | 'error';
  mainFile?: string;
  customCommand?: string;
  ownerId: string;
  createdAt: any;
}

export interface ProjectState {
  files: ProjectFile[];
  stack: StackType;
  status: 'idle' | 'detecting' | 'installing' | 'running' | 'error';
  logs: string[];
}
