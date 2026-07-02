const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;
let serverUrl = null;
let isAppReady = false;

// 注册全局回调，当 Node 服务启动完毕后通知窗口加载
global.onServerListening = (url) => {
    serverUrl = url;
    if (isAppReady) {
        createWindow(url);
    }
};

// 启动后端 Node 服务
require('./server.js');

function createWindow(url) {
    if (mainWindow) return;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "本地文档预览工具",
        autoHideMenuBar: true, // 隐藏顶部的默认菜单栏
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadURL(url);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    isAppReady = true;
    if (serverUrl) {
        createWindow(serverUrl);
    }
});

app.on('window-all-closed', () => {
    app.quit();
});
