import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { BrowserWindow, app, dialog, shell } from 'electron';
import {
  AndroidAgent,
  AndroidDevice,
  getConnectedDevices,
} from '@midscene/android';
import { PlaygroundServer } from '@midscene/playground';
import {
  PLAYGROUND_SERVER_PORT,
  SCRCPY_SERVER_PORT,
} from '@midscene/shared/constants';
import { findAvailablePort } from '@midscene/shared/node';
import cors from 'cors';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

// ──────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────
const isPackaged = app.isPackaged;

// Static web assets (built frontend)
const staticDir = isPackaged
  ? path.join(process.resourcesPath, 'static')
  : path.join(__dirname, '../../../packages/android-playground/static');

// scrcpy-server binary path (resolved at startup by ScrcpyServer)
const scrcpyServerBinPath = isPackaged
  ? path.join(process.resourcesPath, 'bin', 'scrcpy-server')
  : path.join(__dirname, '../../../packages/android-playground/bin/scrcpy-server');

// ──────────────────────────────────────────────────────
// Device discovery
// ──────────────────────────────────────────────────────
async function getAdbDevices() {
  try {
    const devices = await getConnectedDevices();
    return devices
      .filter((d) => d.state === 'device')
      .map((d) => ({ id: d.udid, name: d.udid, status: d.state }));
  } catch {
    return [];
  }
}

async function selectDevice(): Promise<string> {
  const devices = await getAdbDevices();

  if (devices.length === 0) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'No Android Device Found',
      message:
        'No Android devices found.\n\nPlease ensure:\n• Your device is connected via USB\n• USB debugging is enabled\n• Device is authorized for debugging',
    });
    app.quit();
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }

  if (devices.length === 1) {
    return devices[0].id;
  }

  // Multiple devices – let the user pick via dialog
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Select Android Device',
    message: 'Multiple devices found. Please select one:',
    buttons: devices.map((d) => `${d.name} (${d.id})`),
    cancelId: -1,
  });

  if (result.response < 0 || result.response >= devices.length) {
    app.quit();
    process.exit(1);
  }

  return devices[result.response].id;
}

// ──────────────────────────────────────────────────────
// Minimal ScrcpyServer (ported from packages/android-playground)
// ──────────────────────────────────────────────────────
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adb, AdbServerClient } from '@yume-chan/adb';
import { getDebug } from '@midscene/shared/logger';

const debugPage = getDebug('android:playground');
const promiseExec = promisify(exec);

class ScrcpyServer {
  app: express.Application;
  httpServer: ReturnType<typeof createServer>;
  io: SocketIOServer;
  port?: number | null;
  defaultPort = SCRCPY_SERVER_PORT;
  adbClient: AdbServerClient | null = null;
  currentDeviceId: string | null = null;
  devicePollInterval: ReturnType<typeof setInterval> | null = null;
  lastDeviceList = '';
  private scrcpyBinPath: string;

  constructor(scrcpyBin: string) {
    this.scrcpyBinPath = scrcpyBin;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
    });
    this.app.use(cors({ origin: '*', credentials: true }));
    this.setupSocketHandlers();
    this.setupApiRoutes();
  }

  private setupApiRoutes() {
    this.app.get('/api/devices', async (_req, res) => {
      try {
        const devices = await this.getDevicesList();
        res.json({ devices, currentDeviceId: this.currentDeviceId });
      } catch (e: any) {
        res.status(500).json({ error: e.message || 'Failed to get devices list' });
      }
    });
  }

  private async getDevicesList() {
    try {
      const client = await this.getAdbClient();
      if (!client) return [];
      let devices;
      try {
        devices = await client.getDevices();
      } catch {
        return [];
      }
      if (!devices?.length) return [];
      return devices.map((d) => ({
        id: d.serial,
        name: (d as any).product || (d as any).model || d.serial,
        status: (d as any).state || 'device',
      }));
    } catch {
      return [];
    }
  }

  private async getAdbClient() {
    const { AdbServerClient } = await import('@yume-chan/adb');
    const { AdbServerNodeTcpConnector } = await import(
      '@yume-chan/adb-server-node-tcp'
    );
    try {
      if (!this.adbClient) {
        await promiseExec('adb start-server');
        this.adbClient = new AdbServerClient(
          new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }),
        );
      }
      return this.adbClient;
    } catch {
      return null;
    }
  }

  private async getAdb(deviceId?: string) {
    const { Adb } = await import('@yume-chan/adb');
    const client = await this.getAdbClient();
    if (!client) return null;
    const targetId = deviceId || this.currentDeviceId;
    if (targetId) {
      this.currentDeviceId = targetId;
      return new Adb(await client.createTransport({ serial: targetId }));
    }
    const devices = await client.getDevices();
    if (!devices.length) return null;
    this.currentDeviceId = devices[0].serial;
    return new Adb(await client.createTransport(devices[0]));
  }

  private async startScrcpy(adb: Adb, options = {}) {
    const { AdbScrcpyClient, AdbScrcpyOptions2_1 } = await import(
      '@yume-chan/adb-scrcpy'
    );
    const { ReadableStream } = await import('@yume-chan/stream-extra');
    const { ScrcpyOptions3_1, DefaultServerPath } = await import(
      '@yume-chan/scrcpy'
    );
    await AdbScrcpyClient.pushServer(
      adb,
      ReadableStream.from(createReadStream(this.scrcpyBinPath)),
    );
    const scrcpyOptions = new ScrcpyOptions3_1({
      audio: false,
      control: true,
      maxSize: 1024,
      videoBitRate: 2_000_000,
      ...options,
    });
    return AdbScrcpyClient.start(
      adb,
      DefaultServerPath,
      new AdbScrcpyOptions2_1(scrcpyOptions),
    );
  }

  private setupSocketHandlers() {
    this.io.on('connection', async (socket) => {
      debugPage('client connected: %s', socket.id);
      let scrcpyClient: any = null;

      const sendDevicesList = async () => {
        const devices = await this.getDevicesList();
        socket.emit('devices-list', { devices, currentDeviceId: this.currentDeviceId });
      };
      await sendDevicesList();

      socket.on('get-devices', () => sendDevicesList());

      socket.on('switch-device', async (deviceId) => {
        if (scrcpyClient) {
          await scrcpyClient.close().catch(() => {});
          scrcpyClient = null;
        }
        this.currentDeviceId = deviceId;
        socket.emit('device-switched', { deviceId });
        this.io.emit('global-device-switched', { deviceId, timestamp: Date.now() });
      });

      socket.on('connect-device', async (options) => {
        const { ScrcpyVideoCodecId } = await import('@yume-chan/scrcpy');
        try {
          const adb = await this.getAdb(this.currentDeviceId || undefined);
          if (!adb) {
            socket.emit('error', { message: 'No device found' });
            return;
          }
          scrcpyClient = await this.startScrcpy(adb, options);

          if (scrcpyClient?.videoStream) {
            let videoStream = scrcpyClient.videoStream;
            if (typeof videoStream?.then === 'function') {
              videoStream = await videoStream;
            }
            const metadata = videoStream.metadata || {};
            if (!metadata.codec) metadata.codec = ScrcpyVideoCodecId.H264;
            if (!metadata.width) metadata.width = 1080;
            if (!metadata.height) metadata.height = 1920;
            socket.emit('video-metadata', metadata);

            const reader = videoStream.stream.getReader();
            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  socket.emit('video-data', {
                    data: Array.from(value.data),
                    type: value.type || 'data',
                    timestamp: Date.now(),
                    keyFrame: value.keyFrame,
                  });
                }
              } catch {
                socket.emit('error', { message: 'video stream processing error' });
              }
            })();
          }
          if (scrcpyClient?.controller) socket.emit('control-ready');
        } catch (e: any) {
          socket.emit('error', { message: `Failed to connect device: ${e?.message}` });
        }
      });

      socket.on('disconnect', async () => {
        if (scrcpyClient) {
          await scrcpyClient.close().catch(() => {});
          scrcpyClient = null;
        }
      });
    });
  }

  async launch(port?: number) {
    this.port = port || this.defaultPort;
    return new Promise<this>((resolve) => {
      this.httpServer.listen(this.port, () => {
        console.log(`Scrcpy server running at: http://localhost:${this.port}`);
        this.startDeviceMonitoring();
        resolve(this);
      });
    });
  }

  private startDeviceMonitoring() {
    this.devicePollInterval = setInterval(async () => {
      const devices = await this.getDevicesList().catch(() => []);
      const json = JSON.stringify(devices);
      if (this.lastDeviceList !== json) {
        this.lastDeviceList = json;
        if (!this.currentDeviceId && devices.length > 0) {
          const online = devices.filter(
            (d) => d.status.toLowerCase() === 'device',
          );
          if (online.length > 0) this.currentDeviceId = online[0].id;
        }
        this.io.emit('devices-list', {
          devices,
          currentDeviceId: this.currentDeviceId,
        });
      }
    }, 3000);
  }

  close() {
    if (this.devicePollInterval) {
      clearInterval(this.devicePollInterval);
      this.devicePollInterval = null;
    }
    return this.httpServer?.close();
  }
}

// ──────────────────────────────────────────────────────
// Electron lifecycle
// ──────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

function createWindow(url: string) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Midscene Android Playground',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(url);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
    shell.openExternal(externalUrl);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const selectedDeviceId = await selectDevice();
    console.log(`✅ Selected device: ${selectedDeviceId}`);

    const playgroundServer = new PlaygroundServer(
      async () => {
        const device = new AndroidDevice(selectedDeviceId);
        await device.connect();
        return new AndroidAgent(device);
      },
      staticDir,
    );

    const scrcpyServer = new ScrcpyServer(scrcpyServerBinPath);
    scrcpyServer.currentDeviceId = selectedDeviceId;

    playgroundServer.app.use(
      cors({
        origin: true,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      }),
    );

    const availablePlaygroundPort = await findAvailablePort(PLAYGROUND_SERVER_PORT);
    const availableScrcpyPort = await findAvailablePort(SCRCPY_SERVER_PORT);

    await Promise.all([
      playgroundServer.launch(availablePlaygroundPort),
      scrcpyServer.launch(availableScrcpyPort),
    ]);

    (global as any).scrcpyServerPort = availableScrcpyPort;

    console.log('');
    console.log('✨ Midscene Android Playground is ready!');
    console.log(`🎮 Playground: http://localhost:${playgroundServer.port}`);
    console.log(`📱 Device: ${selectedDeviceId}`);

    createWindow(`http://localhost:${playgroundServer.port}`);
  } catch (error) {
    console.error('Failed to start servers:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && BrowserWindow.getAllWindows().length === 0) {
    // Re-launch would need the server to already be running.
    // For simplicity, just quit and re-open.
    app.quit();
  }
});
