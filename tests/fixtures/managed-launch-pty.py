import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import struct
import sys
import termios
import time

request = json.load(sys.stdin)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
child = subprocess.Popen(request['argv'], cwd=request['cwd'], env=request['env'],
                         stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
os.close(slave)
output = bytearray()
deadline = time.monotonic() + 25
sent = False
try:
    while True:
        if time.monotonic() > deadline:
            os.killpg(child.pid, signal.SIGKILL)
            raise RuntimeError('managed launch fixture timed out: ' + repr(bytes(output[-4096:])))
        if select.select([master], [], [], .1)[0]:
            try:
                chunk = os.read(master, 8192)
                if not chunk:
                    break
                output.extend(chunk)
                if b'\x1b[6n' in chunk:
                    os.write(master, b'\x1b[1;1R')
                if not sent and request.get('sendWhen') and request['sendWhen'].encode() in output:
                    os.write(master, request['keys'].encode())
                    sent = True
                if len(output) > 65536:
                    del output[:-65536]
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
        elif child.poll() is not None:
            break
    code = child.wait(timeout=2)
    print(json.dumps({'code': code, 'output': output.decode('utf-8', errors='replace')}))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
