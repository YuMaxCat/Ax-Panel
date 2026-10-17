const { execFile } = require('child_process');

// 列出进程（一次 ps，字段间用 = 去掉表头）
function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,user=,pcpu=,pmem=,rss=,stat=,etime=,args='],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const rows = [];
        for (const line of stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            user: m[3],
            cpu: parseFloat(m[4]),
            mem: parseFloat(m[5]),
            rss: Number(m[6]) * 1024,
            stat: m[7],
            etime: m[8],
            args: m[9] || ''
          });
        }
        resolve(rows);
      }
    );
  });
}

// 结束进程：禁止 PID 1 与面板自身
function killProcess(pid, signal) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('非法 PID');
  if (pid === process.pid) throw new Error('不能结束面板自身');
  const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
  process.kill(pid, sig);
  return sig;
}

module.exports = { listProcesses, killProcess };
