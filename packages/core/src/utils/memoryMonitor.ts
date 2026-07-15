/**
 * System Resource Monitor - 内存不足预警
 * 每隔60秒检测系统内存，低于阈值时弹窗预警
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const CHECK_INTERVAL = 60_000; // 60秒
const WARNING_THRESHOLD = 0.85; // 85%使用率
const CRITICAL_THRESHOLD = 0.95; // 95%使用率
const LOG_FILE = path.join(os.homedir(), '.easycode', 'logs', 'memory-monitor.log');

function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, line);
}

async function getMemoryInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usagePercent = usedMem / totalMem;

  // Windows: get process-specific memory via tasklist
  let processMem = 0;
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2>nul', { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/"[\d,]+\s+K"/g);
      if (match) {
        for (const m of match) {
          const kb = parseInt(m.replace(/["\s,K]/g, ''));
          if (!isNaN(kb)) processMem += kb;
        }
      }
    }
  } catch {}

  return {
    totalMB: Math.round(totalMem / 1024 / 1024),
    usedMB: Math.round(usedMem / 1024 / 1024),
    freeMB: Math.round(freeMem / 1024 / 1024),
    usagePercent: Math.round(usagePercent * 100),
    nodeProcessMB: Math.round(processMem / 1024),
  };
}

async function checkMemory() {
  const mem = await getMemoryInfo();
  const usage = mem.usagePercent;

  if (usage >= CRITICAL_THRESHOLD * 100) {
    log(`CRITICAL: Memory usage ${usage}% (${mem.usedMB}/${mem.totalMB}MB). Node processes: ${mem.nodeProcessMB}MB`);
    // Windows toast notification
    try {
      await execAsync(
        `powershell -Command "New-BurntToastNotification -Text 'Memory Critical','System memory at ${usage}%. Free: ${mem.freeMB}MB. Consider closing applications.' -AppLogo C:\\Windows\\System32\\@WLOGO_100x100.png"`,
        { timeout: 5000 }
      ).catch(() => {});
    } catch {}
    // Also try msg command as fallback
    try {
      await execAsync(`msg * /TIME:30 "CRITICAL: System memory at ${usage}%. Only ${mem.freeMB}MB free. Close some applications!"`, { timeout: 5000 });
    } catch {}
  } else if (usage >= WARNING_THRESHOLD * 100) {
    log(`WARNING: Memory usage ${usage}% (${mem.usedMB}/${mem.totalMB}MB). Node processes: ${mem.nodeProcessMB}MB`);
    // Less aggressive notification
    try {
      await execAsync(
        `powershell -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('Memory usage at ${usage}%. Free: ${mem.freeMB}MB. Consider freeing memory.', 'Memory Warning', 'OK', 'Warning')"`,
        { timeout: 5000 }
      ).catch(() => {});
    } catch {}
  } else {
    // Normal - log every 5 minutes
    if (Date.now() % 300000 < CHECK_INTERVAL) {
      log(`OK: Memory ${usage}% (${mem.usedMB}/${mem.totalMB}MB), Node: ${mem.nodeProcessMB}MB`);
    }
  }
}

// Main loop
log('Memory monitor started');
checkMemory();
setInterval(checkMemory, CHECK_INTERVAL);
