/**
 * Linux hook supervisor executed with `python3 -I -c`.
 *
 * The supervisor becomes a verified child subreaper before it starts untrusted
 * hook code. After the hook exits (or times out), it terminates and reaps every
 * direct or adopted child. A clean protocol record is emitted only after
 * waitpid reports ECHILD, which is the kernel proof that no supervised
 * descendant remains.
 */
export const HOOK_SUPERVISOR_SCRIPT = String.raw`
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
PROTOCOL_FD = 3
TERM_GRACE_SECONDS = 0.5
KILL_GRACE_SECONDS = 4.0

def protocol(record):
    os.write(PROTOCOL_FD, (record + "\n").encode("ascii"))

def establish_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    enabled = ctypes.c_int(0)
    if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(enabled), 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if enabled.value != 1:
        raise RuntimeError("PR_GET_CHILD_SUBREAPER did not confirm setup")

def become_non_dumpable():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise RuntimeError("non-dumpable state was not retained")

def child_identities():
    children_path = "/proc/self/task/%d/children" % os.getpid()
    with open(children_path, "r", encoding="ascii") as children_file:
        pids = [int(value) for value in children_file.read().split()]
    identities = []
    for pid in pids:
        try:
            with open("/proc/%d/stat" % pid, "r", encoding="ascii") as stat_file:
                record = stat_file.read()
            close = record.rfind(")")
            fields = record[close + 2:].split()
            identities.append((pid, int(fields[19])))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return identities

def identity_is_current(pid, starttime):
    try:
        with open("/proc/%d/stat" % pid, "r", encoding="ascii") as stat_file:
            record = stat_file.read()
        close = record.rfind(")")
        fields = record[close + 2:].split()
        if int(fields[19]) != starttime:
            return False
        with open("/proc/self/task/%d/children" % os.getpid(), "r", encoding="ascii") as children_file:
            return str(pid) in children_file.read().split()
    except (FileNotFoundError, ProcessLookupError):
        return False

def signal_children(signum):
    for pid, starttime in child_identities():
        if not identity_is_current(pid, starttime):
            continue
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

def reap_nonblocking():
    while True:
        try:
            waited, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if waited == 0:
            return False

def wait_for_no_children(deadline, signum):
    while time.monotonic() < deadline:
        signal_children(signum)
        if reap_nonblocking():
            return True
        time.sleep(0.01)
    signal_children(signum)
    return reap_nonblocking()

def cleanup_all_children():
    if wait_for_no_children(time.monotonic() + TERM_GRACE_SECONDS, signal.SIGTERM):
        return True
    return wait_for_no_children(time.monotonic() + KILL_GRACE_SECONDS, signal.SIGKILL)

def main():
    if len(sys.argv) < 3:
        raise RuntimeError("missing timeout or hook command")
    timeout_seconds = float(sys.argv[1])
    command = sys.argv[2:]
    establish_subreaper()
    become_non_dumpable()
    protocol("NON_DUMPABLE")
    protocol("READY")

    interrupted = [None]
    def handle_signal(signum, _frame):
        interrupted[0] = signum
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, handle_signal)

    try:
        hook = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
    except BaseException:
        protocol("SPAWN_FAILED")
        raise

    deadline = time.monotonic() + timeout_seconds
    outcome = "normal"
    while hook.poll() is None:
        if interrupted[0] is not None:
            outcome = "signal"
            break
        if time.monotonic() >= deadline:
            outcome = "timeout"
            break
        time.sleep(0.01)

    exit_code = hook.returncode
    if not cleanup_all_children():
        protocol("CLEANUP_FAILED")
        return 126
    protocol("CLEAN " + outcome)
    if outcome == "timeout":
        return 124
    if outcome == "signal":
        return 128 + int(interrupted[0])
    if exit_code is None:
        return 126
    if exit_code < 0:
        return 128 + min(-exit_code, 127)
    return min(exit_code, 255)

try:
    sys.exit(main())
except Exception as error:
    try:
        protocol("SUPERVISOR_FAILED")
    except BaseException:
        pass
    print("hook supervisor: %s" % error, file=sys.stderr)
    sys.exit(125)
`;
