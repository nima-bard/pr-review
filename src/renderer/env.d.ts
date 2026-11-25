declare module '*.css';

declare module 'virtual:file-icons' {
  export const urls: Record<string, string>;
  export const tables: {
    fileExtensions: Record<string, string>;
    fileNames: Record<string, string>;
    folderNames: Record<string, string>;
    file: string;
    folder: string;
  };
}

declare module '*?raw' {
  const text: string;
  export default text;
}

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
