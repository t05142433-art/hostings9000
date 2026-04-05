import { ProjectFile, StackType } from '../types';

export function detectStack(files: ProjectFile[]): StackType {
  const fileNames = files.map(f => f.name.toLowerCase());
  
  // Vite check
  if (fileNames.includes('vite.config.ts') || fileNames.includes('vite.config.js')) {
    return 'vite';
  }
  
  // Node check
  if (fileNames.includes('package.json')) {
    return 'node';
  }
  
  // Python check
  if (fileNames.includes('requirements.txt') || fileNames.some(name => name.endsWith('.py'))) {
    return 'python';
  }
  
  return 'unknown';
}
