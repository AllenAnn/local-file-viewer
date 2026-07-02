const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// 注册自定义本地文件访问协议，支持突破 CSP 和加载本地磁盘图片
protocol.registerSchemesAsPrivileged([
    { scheme: 'local-file', privileges: { bypassCSP: true, secure: true, supportFetchAPI: true } }
]);

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon'
};

const isPackaged = app.isPackaged;
let baseDir = __dirname;
if (isPackaged) {
    baseDir = path.dirname(process.execPath);
}
let currentWatchDir = path.join(baseDir, 'files');

// 确保监测文件夹存在
if (!fs.existsSync(currentWatchDir)) {
    fs.mkdirSync(currentWatchDir, { recursive: true });
}

function createWindow() {
    if (mainWindow) return;

    const iconPath = path.join(__dirname, 'icon.jpg');
    let iconImage = null;
    if (fs.existsSync(iconPath)) {
        iconImage = nativeImage.createFromPath(iconPath);
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "本地文档预览工具",
        autoHideMenuBar: true,
        icon: iconImage,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // 注册自定义本地文件加载协议处理程序，使用 fs 直接读取以完美支持本地图片
    protocol.handle('local-file', async (request) => {
        try {
            let urlString = request.url;
            let filePath = '';
            
            const prefix = 'local-file://';
            if (urlString.startsWith(prefix)) {
                filePath = urlString.slice(prefix.length);
            }
            
            // 兼容 local-file:///E:/... 多斜杠路径，去除开头的斜杠以正确保留 Windows 盘符
            if (filePath.startsWith('/')) {
                filePath = filePath.substring(1);
            }
            
            filePath = decodeURIComponent(filePath);
            filePath = path.normalize(filePath);

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            
            const data = await fs.promises.readFile(filePath);
            return new Response(data, {
                headers: { 'Content-Type': contentType }
            });
        } catch (e) {
            console.error('加载本地资源协议出错:', e, '请求 URL:', request.url);
            return new Response('Error loading local resource: ' + e.message, { status: 500 });
        }
    });

    // 注册 IPC 处理程序
    ipcMain.handle('get-current-directory', () => {
        return currentWatchDir;
    });

    ipcMain.handle('select-directory-dialog', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '请选择您想要监测并预览文档的本地文件夹'
        });
        if (!result.canceled && result.filePaths.length > 0) {
            currentWatchDir = path.resolve(result.filePaths[0]);
            return { success: true, directory: currentWatchDir };
        }
        return { success: false, reason: 'cancelled' };
    });

    ipcMain.handle('set-directory', async (event, targetDir) => {
        if (!targetDir) {
            return { success: false, error: '目录路径不能为空' };
        }
        const resolved = path.resolve(targetDir);
        try {
            const stats = await fs.promises.stat(resolved);
            if (stats.isDirectory()) {
                currentWatchDir = resolved;
                return { success: true, directory: currentWatchDir };
            }
        } catch (e) {}
        return { success: false, error: '该路径不存在，或不是一个有效的文件夹目录' };
    });

    ipcMain.handle('navigate-directory', async (event, action, name) => {
        if (action === 'enter') {
            const target = path.join(currentWatchDir, name);
            try {
                const stats = await fs.promises.stat(target);
                if (stats.isDirectory()) {
                    currentWatchDir = target;
                    return { success: true, directory: currentWatchDir };
                }
            } catch (e) {}
            return { success: false, error: '该子文件夹不存在' };
        } else if (action === 'back') {
            const parent = path.dirname(currentWatchDir);
            currentWatchDir = parent;
            return { success: true, directory: currentWatchDir };
        }
        return { success: false, error: '无效的操作' };
    });

    ipcMain.handle('list-files', async () => {
        try {
            const files = await fs.promises.readdir(currentWatchDir, { withFileTypes: true });
            const list = [];
            const filteredItems = files.filter(file => {
                if (file.isDirectory()) return true;
                if (file.isFile()) {
                    const ext = path.extname(file.name).toLowerCase();
                    return ['.md', '.docx', '.xlsx', '.xls', '.csv'].includes(ext);
                }
                return false;
            });

            for (const file of filteredItems) {
                const filePath = path.join(currentWatchDir, file.name);
                try {
                    const stats = await fs.promises.stat(filePath);
                    if (file.isDirectory()) {
                        list.push({
                            name: file.name,
                            type: 'dir',
                            mtime: stats.mtime.getTime()
                        });
                    } else {
                        const ext = path.extname(file.name).toLowerCase();
                        list.push({
                            name: file.name,
                            type: 'file',
                            size: stats.size,
                            mtime: stats.mtime.getTime(),
                            ext: ext
                        });
                    }
                } catch (e) {}
            }

            const dirs = list.filter(item => item.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
            const fileItems = list.filter(item => item.type === 'file').sort((a, b) => b.mtime - a.mtime);
            const parentPath = path.dirname(currentWatchDir);
            const isRoot = parentPath === currentWatchDir;

            return {
                files: [...dirs, ...fileItems],
                currentDirectory: currentWatchDir,
                isRoot: isRoot
            };
        } catch (err) {
            return { error: '读取文件目录失败', details: err.message };
        }
    });

    ipcMain.handle('read-file', async (event, filePath, encoding) => {
        const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(currentWatchDir, filePath);
        if (encoding === 'utf-8') {
            return await fs.promises.readFile(resolvedPath, 'utf-8');
        } else {
            const buffer = await fs.promises.readFile(resolvedPath);
            return new Uint8Array(buffer);
        }
    });

    ipcMain.handle('resolve-path', (event, relativePath) => {
        return path.resolve(currentWatchDir, relativePath);
    });

    ipcMain.handle('open-in-system', async (event, filePath) => {
        const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(currentWatchDir, filePath);
        await shell.openPath(resolvedPath);
    });

    ipcMain.handle('show-in-folder', async (event, filePath) => {
        const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(currentWatchDir, filePath);
        shell.showItemInFolder(resolvedPath);
    });

    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});
