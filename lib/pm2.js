const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IGNORE_FILE = path.join(DATA_DIR, 'pm2-ignore.json');
const ACTIONS = ['start', 'stop', 'restart'];

let cfg = null;
let ignoreList = []; // 不产生「离线」告警的 pm2 进程名（例如故意停用的服务）

/* ---------- 离线告警忽略名单 ---------- */

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8'));
    ignoreList = Array.isArray(d) ? d.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    ignoreList = [];
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(IGNORE_FILE, JSON.stringify(ignoreList, null, 2));
  } catch (e) { /* ignore */ }
}

function isIgnored(name) {
  return ignoreList.indexOf(name) >= 0;
}

function setIgnore(name, ignored) {
  const i = ignoreList.indexOf(name);
  if (ignored && i < 0) ignoreList.push(name);
  else if (!ignored && i >= 0) ignoreList.splice(i, 1);
  save();
  return ignoreList.slice();
}

/* ---------- 进程列表 ---------- */

function jlist() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      let list;
      try { list = JSON.parse(stdout); } catch (e) { return resolve([]); }
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

// 优先看标准输出日志，没有则退回错误日志；两者都不存在给 null（前端据此隐藏「日志」按钮）
function logFileOf(name) {
  if (!cfg || !cfg.pm2LogDir) return null;
  const out = path.join(cfg.pm2LogDir, name + '-out.log');
  if (fs.existsSync(out)) return out;
  const err = path.join(cfg.pm2LogDir, name + '-error.log');
  if (fs.existsSync(err)) return err;
  return null;
}

async function list() {
  const raw = await jlist();
  return raw.map((p) => {
    const env = p.pm2_env || {};
    // monit 挂在进程对象顶层（不在 pm2_env 里），且只在进程存活时才有值
    const monit = p.monit || {};
    const alive = env.status === 'online';
    return {
      name: p.name,
      status: env.status || 'unknown',
      restarts: env.restart_time || 0,
      // monit 只在进程存活时才有数据，取不到就填 0
      cpu: alive ? (monit.cpu || 0) : 0,
      mem: alive ? (monit.memory || 0) : 0,
      ignored: isIgnored(p.name),
      logFile: logFileOf(p.name)
    };
  });
}

/* ---------- 启停操作 ---------- */

function action(name, act) {
  return new Promise((resolve, reject) => {
    if (ACTIONS.indexOf(act) < 0) return reject(new Error('不支持的操作：' + act));
    // 面板没有外部守护，停掉就再也起不来了
    if (name === 'admin' && act === 'stop') {
      return reject(new Error('不能停止面板自身，否则将无法远程恢复'));
    }
    jlist().then((raw) => {
      if (!raw.some((p) => p.name === name)) return reject(new Error('未找到 pm2 进程：' + name));
      // 全程不拼 shell，参数走数组传入，避免注入
      execFile('pm2', [act, name], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = ((stderr || '') + (stdout || '')).toString().trim() || err.message;
          return reject(new Error(msg || 'pm2 命令执行失败'));
        }
        resolve({ ok: true });
      });
    }).catch(reject);
  });
}

function start(config) {
  cfg = config || null;
  load();
}

module.exports = { start, list, jlist, action, isIgnored, setIgnore };
