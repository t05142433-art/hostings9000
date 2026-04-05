import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { ProjectFile } from '../types';

export async function exportToZip(files: ProjectFile[], projectName: string = 'project-export') {
  const zip = new JSZip();
  
  files.forEach(file => {
    // JSZip handles both string and ArrayBuffer
    zip.file(file.path, file.content);
  });
  
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, `${projectName}.zip`);
}
