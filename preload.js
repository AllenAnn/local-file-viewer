const { contextBridge, ipcRenderer } = require('electron');

console.log("=== Preload script executing! ===");

contextBridge.exposeInMainWorld('electronAPI', {
    getCurrentDirectory: () => ipcRenderer.invoke('get-current-directory'),
    selectDirectoryDialog: () => ipcRenderer.invoke('select-directory-dialog'),
    setDirectory: (directory) => ipcRenderer.invoke('set-directory', directory),
    navigateDirectory: (action, name) => ipcRenderer.invoke('navigate-directory', action, name),
    listFiles: () => ipcRenderer.invoke('list-files'),
    readFile: (filePath, encoding) => ipcRenderer.invoke('read-file', filePath, encoding),
    resolvePath: (relativePath) => ipcRenderer.invoke('resolve-path', relativePath),
    openInSystem: (filePath) => ipcRenderer.invoke('open-in-system', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath)
});
