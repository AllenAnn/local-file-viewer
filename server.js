const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const isElectron = typeof process.versions.electron !== 'undefined';
const isPackaged = isElectron ? require('electron').app.isPackaged : false;

const PORT = 8989;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 打包后的应用在 exe 所在物理目录下寻找/创建 files 文件夹
let baseDir = __dirname;
if (isPackaged) {
    baseDir = path.dirname(process.execPath);
}
let currentWatchDir = path.join(baseDir, 'files');

// 确保初始目录存在
if (!fs.existsSync(currentWatchDir)) {
    fs.mkdirSync(currentWatchDir, { recursive: true });
}
if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// 路径安全校验函数，防御目录穿越越权访问
function isPathSafe(targetPath, baseDir) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(baseDir);
    const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
    return resolvedTarget === resolvedBase || resolvedTarget.startsWith(baseWithSep);
}

// 常见文件的 Content-Type 映射
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    // 允许跨域
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 解码中文 URL，防止中文文件名解析出错
    let reqPath = '';
    try {
        reqPath = decodeURIComponent(req.url);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('URL 解码失败');
        return;
    }

    // 1. 处理调用本地 Windows 文件夹选择框的 API
    if (req.method === 'GET' && reqPath === '/api/select-directory-dialog') {
        if (isElectron) {
            const { dialog } = require('electron');
            dialog.showOpenDialog({
                properties: ['openDirectory'],
                title: '请选择您想要监测并预览文档的本地文件夹'
            }).then(result => {
                if (!result.canceled && result.filePaths.length > 0) {
                    currentWatchDir = path.resolve(result.filePaths[0]);
                    console.log(`用户通过系统弹窗将监测目录切换为: ${currentWatchDir}`);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, directory: currentWatchDir }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, reason: 'cancelled' }));
                }
            }).catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '无法调起系统文件夹选择器', details: err.message }));
            });
            return;
        }

        // 降级使用 PowerShell
        const psScript = "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '请选择您想要监测并预览文档的本地文件夹'; $dialog.ShowNewFolderButton = $true; $res = $dialog.ShowDialog(); if ($res -eq 'OK') { Write-Output $dialog.SelectedPath }";
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`;
        
        exec(cmd, (err, stdout) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '无法调起系统文件夹选择器', details: err.message }));
                return;
            }
            const selectedPath = stdout.trim();
            if (selectedPath) {
                currentWatchDir = path.resolve(selectedPath);
                console.log(`用户通过弹窗将监测目录切换为: ${currentWatchDir}`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, directory: currentWatchDir }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, reason: 'cancelled' }));
            }
        });
        return;
    }

    // 2. 处理直接在输入框修改监测目录的 POST 接口
    if (req.method === 'POST' && reqPath === '/api/set-directory') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const targetDir = data.directory;
                if (!targetDir) {
                    throw new Error('目录路径不能为空');
                }

                fs.stat(targetDir, (err, stats) => {
                    if (err || !stats.isDirectory()) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ error: '该路径不存在，或不是一个有效的文件夹目录' }));
                    } else {
                        currentWatchDir = path.resolve(targetDir);
                        console.log(`成功将监测目录切换为: ${currentWatchDir}`);
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: true, directory: currentWatchDir }));
                    }
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 3. 处理在侧边栏中双击/点击文件夹进行“前进”或“后退”目录的接口
    if (req.method === 'POST' && reqPath === '/api/navigate') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { action, name } = data;

                if (action === 'enter') {
                    const target = path.join(currentWatchDir, name);
                    fs.stat(target, (err, stats) => {
                        if (!err && stats.isDirectory()) {
                            currentWatchDir = target;
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true, directory: currentWatchDir }));
                        } else {
                            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ error: '该子文件夹不存在' }));
                        }
                    });
                } else if (action === 'back') {
                    const parent = path.dirname(currentWatchDir);
                    currentWatchDir = parent;
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, directory: currentWatchDir }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '无效的操作' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 4. 核心优化：专门用于高兼容性加载相对路径图片、带“..”路径、反斜杠图片、本地绝对图片路径的 API 路由
    if (reqPath.startsWith('/api/image')) {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            const imgRelativePath = urlObj.searchParams.get('path');
            
            if (!imgRelativePath) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('缺少图片路径参数 path');
                return;
            }

            const imgAbsolutePath = path.resolve(currentWatchDir, imgRelativePath);
            if (!isPathSafe(imgAbsolutePath, currentWatchDir)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('禁止访问：安全原因，路径越权');
                return;
            }
            serveFile(imgAbsolutePath, res);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`图片加载失败: ${err.message}`);
        }
        return;
    }

    // 静态与数据分发
    if (reqPath === '/' || reqPath === '/index.html') {
        serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
    } else if (reqPath.startsWith('/public/')) {
        const filePath = path.join(PUBLIC_DIR, reqPath.substring(8));
        const resolvedPath = path.resolve(filePath);
        if (!isPathSafe(resolvedPath, PUBLIC_DIR)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('禁止访问：安全原因，路径越权');
            return;
        }
        serveFile(resolvedPath, res);
    } else if (reqPath.startsWith('/files/')) {
        const filePath = path.join(currentWatchDir, reqPath.substring(7));
        const resolvedPath = path.resolve(filePath);
        if (!isPathSafe(resolvedPath, currentWatchDir)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('禁止访问：安全原因，路径越权');
            return;
        }
        serveFile(resolvedPath, res);
    } else if (reqPath === '/api/current-directory') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ directory: currentWatchDir }));
    } else if (reqPath === '/api/files') {
        listLocalFilesAndFolders(res);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('文件未找到 404');
    }
});

// 服务静态文件的方法
function serveFile(filePath, res) {
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('文件未找到 404');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size
        });

        const stream = fs.createReadStream(filePath);
        stream.on('error', (streamErr) => {
            console.error('文件读取流出错:', streamErr);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('服务器内部错误');
            }
        });
        stream.pipe(res);
    });
}

// 获取当前监测目录下的所有子文件夹及支持预览的文件
function listLocalFilesAndFolders(res) {
    fs.readdir(currentWatchDir, { withFileTypes: true }, (err, files) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '读取文件目录失败', details: err.message }));
            return;
        }

        const list = [];
        const filteredItems = files.filter(file => {
            if (file.isDirectory()) return true;
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                return ['.md', '.docx', '.xlsx', '.xls', '.csv'].includes(ext);
            }
            return false;
        });

        let pending = filteredItems.length;
        const parentPath = path.dirname(currentWatchDir);
        const isRoot = parentPath === currentWatchDir;

        if (pending === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                files: [],
                currentDirectory: currentWatchDir,
                isRoot: isRoot
            }));
            return;
        }

        filteredItems.forEach((file) => {
            const filePath = path.join(currentWatchDir, file.name);
            fs.stat(filePath, (statErr, stats) => {
                pending--;

                if (!statErr) {
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
                }

                if (pending === 0) {
                    const dirs = list.filter(item => item.type === 'dir').sort((a, b) => a.name.localeCompare(b.name));
                    const fileItems = list.filter(item => item.type === 'file').sort((a, b) => b.mtime - a.mtime);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        files: [...dirs, ...fileItems],
                        currentDirectory: currentWatchDir,
                        isRoot: isRoot
                    }));
                }
            });
        });
    });
}

// 端口自动递增分配启动逻辑
let currentPort = PORT;

const startServer = () => {
    server.listen(currentPort);
};

server.on('listening', () => {
    const url = `http://localhost:${currentPort}`;
    console.log(`==================================================`);
    console.log(`本地文档预览服务已成功启动！`);
    console.log(`请在浏览器中访问: ${url}`);
    console.log(`==================================================`);

    if (isElectron) {
        if (global.onServerListening) {
            global.onServerListening(url);
        }
    } else {
        const cmd = process.platform === 'win32' ? `start ${url}` :
                    process.platform === 'darwin' ? `open ${url}` :
                    `xdg-open ${url}`;
        
        exec(cmd, (execErr) => {
            if (execErr) {
                console.log(`自动打开浏览器失败，请手动在浏览器中输入: ${url}`);
            } else {
                console.log(`已为您自动在默认浏览器中打开网页！`);
            }
        });
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`端口 ${currentPort} 已被占用，正在尝试切换到 ${currentPort + 1}...`);
        currentPort++;
        setTimeout(() => {
            startServer();
        }, 100);
    } else {
        console.error('服务器启动出错:', err);
    }
});

startServer();
