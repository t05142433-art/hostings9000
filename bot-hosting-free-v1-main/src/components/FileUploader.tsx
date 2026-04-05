import React, { useRef, useState } from 'react';
import { Upload, FolderOpen, FileCode, CheckCircle2 } from 'lucide-react';
import { ProjectFile } from '../types';

interface FileUploaderProps {
  onFilesSelected: (files: ProjectFile[], rawFiles?: File[]) => void;
  isProcessing: boolean;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFilesSelected, isProcessing }) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const projectFiles: ProjectFile[] = [];
    const rawFiles: File[] = Array.from(files);
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const content = await readFile(file);
      projectFiles.push({
        name: file.name,
        path: (file as any).webkitRelativePath || file.name,
        content,
        type: file.type
      });
    }
    
    onFilesSelected(projectFiles, rawFiles);
  };

  const readFile = (file: File): Promise<string | ArrayBuffer> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string | ArrayBuffer);
      
      // Read as text for code files, array buffer for others
      if (file.type.startsWith('text/') || file.name.endsWith('.json') || file.name.endsWith('.ts') || file.name.endsWith('.tsx') || file.name.endsWith('.js') || file.name.endsWith('.py')) {
        reader.readAsText(file);
      } else {
        reader.readAsArrayBuffer(file);
      }
    });
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const items = e.dataTransfer.items;
    if (!items) return;

    const projectFiles: ProjectFile[] = [];
    const rawFiles: File[] = [];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i].webkitGetAsEntry();
      if (item) {
        await traverseFileTree(item, '', projectFiles, rawFiles);
      }
    }
    
    onFilesSelected(projectFiles, rawFiles);
  };

  const traverseFileTree = async (item: any, path: string, projectFiles: ProjectFile[], rawFiles: File[]) => {
    path = path || '';
    if (item.isFile) {
      const file = await new Promise<File>((resolve) => item.file(resolve));
      // Add relative path for multer
      Object.defineProperty(file, 'webkitRelativePath', {
        value: path + file.name
      });
      rawFiles.push(file);
      
      const content = await readFile(file);
      projectFiles.push({
        name: file.name,
        path: path + file.name,
        content,
        type: file.type
      });
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const entries = await new Promise<any[]>((resolve) => dirReader.readEntries(resolve));
      for (let i = 0; i < entries.length; i++) {
        await traverseFileTree(entries[i], path + item.name + '/', projectFiles, rawFiles);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`
          relative border-2 border-dashed rounded-2xl p-12 transition-all duration-300 flex flex-col items-center justify-center gap-4
          ${isDragging ? 'border-emerald-500 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}
          ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
        `}
      >
        <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400">
          <Upload size={32} />
        </div>
        <div className="text-center">
          <h3 className="text-lg font-medium text-zinc-200">Import your project</h3>
          <p className="text-sm text-zinc-500 mt-1">Drag and drop folders or files here</p>
        </div>
        
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => folderInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition-colors"
          >
            <FolderOpen size={16} />
            Select Folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition-colors"
          >
            <FileCode size={16} />
            Select Files
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
};
