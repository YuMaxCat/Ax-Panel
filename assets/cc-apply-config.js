#!/usr/bin/env node
'use strict';
//
// 装机脚本的「写配置」环节 —— Termux 与 Windows **共用这一份**。
//
// 两个平台最后要落地的配置是同一批东西：settings.json（端点 / 模型 / 关自动更新）、
// .claude.json（跳过引导 / 信任目录 / Key 免确认）、全局 CLAUDE.md。差别只有两点：
//   · Termux 还要往 shell 启动文件里写四个环境变量，Windows 不需要（也不该碰 profile）
//   · Windows 要告诉 Claude Code 去哪找 Git Bash
// 合在一份里，以后加配置项不用记得改两处 —— 分成两份正是最容易慢慢跑偏的地方。
//
// 用法:
//   node cc-apply-config.js --task=config     # settings.json + .claude.json（+ 可选 shell rc）
//   node cc-apply-config.js --task=claude-md  # 全局 CLAUDE.md，已存在且非空则跳过
//
// 参数一律走环境变量（CC_*），不走命令行 —— 路径里可能带空格、中文、反斜杠、冒号，
// 塞进 argv 就得两边各自处理引号；环境变量是原样传递的，不需要转义。
// 需要报错时用非零退出码：两边的调用者都只看退出码，不看输出。
//
//   CC_HOME                 家目录（默认 os.homedir()）
//   CC_STATE_DIR            .claude.json 的落点（默认 = CC_HOME）。只在配置目录被
//                           CLAUDE_CONFIG_DIR 重定向时才传 —— 那时 .claude.json 也搬进了
//                           配置目录，不传就会写到 Claude Code 根本不读的地方
//   CC_BASE_URL             上游端点
//   CC_API_KEY              客户自己的 Key
//   CC_MODEL / CC_SMALL_MODEL
//   CC_CONTEXT_TOKENS       上下文窗口
//   CC_MODEL_BEHAVES_AS / CC_SMALL_BEHAVES_AS   模型选择器里的「按谁的行为跑」
//   CC_DEFAULT_MODEL_FIELD  首次安装的默认选中项（已有值不动）
//   CC_TRUST_DIRS           要预先信任的目录，**换行分隔**（路径里不会出现换行，
//                           所以比冒号安全 —— Windows 的盘符自带冒号）
//   CC_RC_FILE              shell 启动文件；留空 = 不写（Windows 传空）
//   CC_GIT_BASH_PATH        Git Bash 的 bash.exe；留空 = 不写（Termux 传空）
//   CC_MD_B64               全局 CLAUDE.md 的正文，base64（仅 --task=claude-md）
//
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 日志 ----------
// 颜色/前缀都和 runner 里那几个 shell 函数保持一致，客户看到的是一套输出
const TTY = process.stdout.isTTY;
const C_RED = TTY ? '\x1b[31m' : '';
const C_CYN = TTY ? '\x1b[36m' : '';
const C_YLW = TTY ? '\x1b[33m' : '';
const C_RST = TTY ? '\x1b[0m' : '';

function log(msg) { process.stdout.write(C_CYN + '[Ax]' + C_RST + ' ' + msg + '\n'); }
function warn(msg) { process.stdout.write(C_YLW + '[注意]' + C_RST + ' ' + msg + '\n'); }
function die(msg) { process.stderr.write(C_RED + '[错误]' + C_RST + ' ' + msg + '\n'); process.exit(1); }

// 空串按「没传」处理，和 shell 里的 ${VAR:-默认值} 一致
function env(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt === undefined ? '' : dflt;
  return v;
}

function readJson(f) {
  try {
    // 开头那个 U+FEFF 必须去掉：Windows 的记事本、PowerShell 5.1 的
    // Set-Content -Encoding UTF8 都会写 BOM，而 JSON.parse 见到 BOM 直接抛。
    // 抛了就会退回空配置，把客户自己改过的设置整份覆盖掉
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return {}; // 文件不存在 / 内容坏了都当空配置，后面在原基础上合并
  }
}

// 不带 BOM 的 UTF-8：PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
// Claude Code 读 settings.json 时不认，所以两边都从这里落盘
function writeJson(f, obj) {
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
}

// ---------- 三项配置 ----------

// shell 启动文件里的四个环境变量。用哨兵块包住，重复安装只会替换那一块，
// 不会把客户自己的 .bashrc 内容冲掉。
function writeRc(a) {
  if (!a.rcFile) return;
  const rc = a.rcFile;
  if (!fs.existsSync(rc)) fs.writeFileSync(rc, '');

  const start = '# >>> claude-code-setup >>>';
  const end = '# <<< claude-code-setup <<<';
  const lines = [
    'export ANTHROPIC_BASE_URL="' + a.baseUrl + '"',
    'export ANTHROPIC_API_KEY="' + a.apiKey + '"',
    'export ANTHROPIC_MODEL="' + a.model + '"',
    'export ANTHROPIC_SMALL_FAST_MODEL="' + a.smallModel + '"'
  ];
  const block = '\n' + start + '\n' + lines.join('\n') + '\n' + end + '\n';

  let content = fs.readFileSync(rc, 'utf8');
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s >= 0 && e >= 0) {
    content = content.slice(0, s) + block + content.slice(e + end.length);
  } else {
    content = content.replace(/\n?$/, '\n') + block;
  }
  fs.writeFileSync(rc, content);
  log('环境变量已写入: ' + rc);
}

function writeSettings(a) {
  const dir = path.join(a.home, '.claude');
  const f = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });

  const cfg = readJson(f);
  const e = {
    ANTHROPIC_BASE_URL: a.baseUrl,
    ANTHROPIC_API_KEY: a.apiKey,
    ANTHROPIC_MODEL: a.model,
    ANTHROPIC_SMALL_FAST_MODEL: a.smallModel,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: a.contextTokens,
    DISABLE_AUTOUPDATER: '1'
  };
  // 只有 Windows 会传：Claude Code 靠它找到 Git Bash。没装成 Git 就不写，
  // 让它退化成内置的 PowerShell 工具（官方支持的降级路径）
  if (a.gitBashPath) e.CLAUDE_CODE_GIT_BASH_PATH = a.gitBashPath;

  cfg.env = Object.assign({}, cfg.env, e);
  cfg.modelPicker = {
    options: [
      { model: a.model, label: 'DeepSeek Flash', behavesAs: a.modelBehavesAs },
      { model: a.smallModel, label: 'DeepSeek Flash Vision (small/fast)', behavesAs: a.smallBehavesAs }
    ]
  };
  // model 字段是首次安装时的默认选中项；已有值不动，避免覆盖手动 /model 的选择
  if (!cfg.model && a.defaultModelField) cfg.model = a.defaultModelField;

  writeJson(f, cfg);
  log('已合并 settings.json（模型 ' + a.model + '）');
  log('DISABLE_AUTOUPDATER=1 已设置：自动更新会绕过本机的安装方式，导致跑不起来');
}

// 跳过首次启动的引导 / 信任目录 / 自定义 Key 的确认框
function writeClientState(a) {
  // 默认在主目录；配置目录被重定向时 Claude Code 改去 <配置目录>/.claude.json 读，
  // 那时必须跟着写过去，否则这份状态等于没写（引导照弹、信任目录照问）
  const f = path.join(a.stateDir, '.claude.json');
  const cfg = readJson(f);

  cfg.hasCompletedOnboarding = true;
  cfg.projects = cfg.projects || {};
  for (const dir of a.trustDirs) {
    if (!dir) continue;
    cfg.projects[dir] = Object.assign({}, cfg.projects[dir], { hasTrustDialogAccepted: true });
  }

  // Claude Code 只认 customApiKeyResponses.approved 里出现过的指纹，
  // 否则首次启动会弹「Detected a custom API key」确认框，光标默认停在 No
  const fp = String(a.apiKey || '').slice(-20);
  if (fp) {
    const prev = cfg.customApiKeyResponses || {};
    const approved = Array.isArray(prev.approved) ? prev.approved.slice() : [];
    if (!approved.includes(fp)) approved.push(fp);
    cfg.customApiKeyResponses = {
      approved,
      rejected: (Array.isArray(prev.rejected) ? prev.rejected : []).filter((x) => x !== fp)
    };
  }

  writeJson(f, cfg);
  log('已配置 .claude.json（跳过引导 + 信任目录 + Key 免确认）');
}

function writeClaudeMd(a) {
  const dir = path.join(a.home, '.claude');
  const f = path.join(dir, 'CLAUDE.md');
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(f) && fs.statSync(f).size > 0) {
    log('已存在全局 CLAUDE.md，跳过（不会覆盖你自己的守则）: ' + f);
    return;
  }
  const md = Buffer.from(a.mdB64, 'base64').toString('utf8');
  if (!md.trim()) die('全局 CLAUDE.md 内容为空，安装中止。');
  fs.writeFileSync(f, md);
  log('已写入全局 CLAUDE.md: ' + f);
}

// ---------- 入口 ----------

const TASKS = {
  config: (a) => { writeRc(a); writeSettings(a); writeClientState(a); },
  'claude-md': writeClaudeMd
};

function main() {
  const argv = process.argv.slice(2);
  let task = '';
  for (const s of argv) {
    if (s.startsWith('--task=')) task = s.slice(7);
  }
  const run = Object.prototype.hasOwnProperty.call(TASKS, task) ? TASKS[task] : null;
  if (!run) die('用法: node cc-apply-config.js --task=config|claude-md');

  const home = env('CC_HOME') || os.homedir();
  const a = {
    home: home,
    stateDir: env('CC_STATE_DIR') || home,
    baseUrl: env('CC_BASE_URL'),
    apiKey: env('CC_API_KEY'),
    model: env('CC_MODEL'),
    smallModel: env('CC_SMALL_MODEL'),
    contextTokens: env('CC_CONTEXT_TOKENS', '1000000'),
    modelBehavesAs: env('CC_MODEL_BEHAVES_AS', 'claude-opus-4-8'),
    smallBehavesAs: env('CC_SMALL_BEHAVES_AS', 'claude-haiku-4-5'),
    defaultModelField: env('CC_DEFAULT_MODEL_FIELD', 'sonnet[1m]'),
    trustDirs: env('CC_TRUST_DIRS').split('\n').map((s) => s.trim()).filter(Boolean),
    rcFile: env('CC_RC_FILE'),
    gitBashPath: env('CC_GIT_BASH_PATH'),
    mdB64: env('CC_MD_B64')
  };

  // 端点与模型是机器锁解出来的，为空说明第 2 步被跳过了或者没解开。
  // config 任务一律要求它们到齐，免得静默写出一份空端点的配置让客户对着 claude 发呆
  if (task === 'config' && (!a.baseUrl || !a.model)) {
    die('缺少端点配置（机器锁未通过），请重新执行安装命令。');
  }
  if (a.apiKey && !/^[A-Za-z0-9._-]+$/.test(a.apiKey)) {
    die('API Key 含非法字符（只允许字母、数字、. _ -），请检查后重试。');
  }

  try {
    run(a);
  } catch (e) {
    die('写配置失败：' + (e && e.message ? e.message : e));
  }
}

main();
