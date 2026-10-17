#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板终端用的 PTY 桥 —— 顶替 node-pty 那个原生模块。

node-pty 是 C++ 原生模块，编译产物与 Node 的 ABI 版本绑死，会把整台机器钉在
某个 Node 大版本上。这个桥只用 Python 标准库（pty/termios/fcntl/select），
系统自带 python3 即可，不需要编译。

用法：pty-bridge.py <shell> [args...]

通道约定（由 Node 侧 spawn 时定好）：
  fd 0  键盘输入，原样写进 pty
  fd 1  pty 输出，原样吐给 Node
  fd 2  stderr，只在自身出错时用
  fd 3  控制通道，按行收 "resize <cols> <rows>"

子进程退出 / Node 侧断开时本进程自行收尾。
"""
import os
import sys
import pty
import fcntl
import struct
import termios
import select
import signal

CTRL_FD = 3
CHUNK = 65536
DEFAULT_COLS = 80
DEFAULT_ROWS = 24


def set_winsize(fd, cols, rows):
    """把一个 pty 的窗口尺寸设成 cols x rows（TIOCSWINSZ 要的是 rows 在前）。"""
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    argv = sys.argv[1:] or ['/bin/bash', '-l']

    pid, master = pty.fork()
    if pid == 0:
        # 子进程：从端已经占住 0/1/2，控制通道不能留给 shell
        try:
            os.close(CTRL_FD)
        except OSError:
            pass
        try:
            os.execvp(argv[0], argv)
        except Exception:
            os._exit(127)

    # 父进程：pty 的从端在子进程手里，这边拿到的是 master
    set_winsize(master, DEFAULT_COLS, DEFAULT_ROWS)

    # Node 侧 kill() 发的是 SIGTERM —— 顺手把 shell 带走，别留孤儿
    def on_term(_signum, _frame):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, on_term)

    watched = {master, 0, CTRL_FD}
    ctrl_buf = b''

    while True:
        try:
            ready, _, _ = select.select(list(watched), [], [])
        except (InterruptedError, OSError):
            continue

        if master in ready:
            try:
                data = os.read(master, CHUNK)
            except OSError:
                break
            if not data:
                break  # 从端全关了 = shell 退出
            try:
                os.write(1, data)
            except OSError:
                break

        if 0 in ready:
            try:
                data = os.read(0, CHUNK)
            except OSError:
                data = b''
            if data:
                try:
                    os.write(master, data)
                except OSError:
                    break
            else:
                watched.discard(0)  # Node 关了 stdin：shell 想活就让它活

        if CTRL_FD in ready:
            try:
                chunk = os.read(CTRL_FD, 4096)
            except OSError:
                chunk = b''
            if not chunk:
                watched.discard(CTRL_FD)
            else:
                ctrl_buf += chunk
                while b'\n' in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b'\n', 1)
                    parts = line.split()
                    if len(parts) == 3 and parts[0] == b'resize':
                        try:
                            set_winsize(master, int(parts[1]), int(parts[2]))
                        except (ValueError, OSError):
                            pass

    try:
        os.close(master)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        pass


if __name__ == '__main__':
    main()
