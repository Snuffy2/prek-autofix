/**
 * Linux hook supervisor executed with `python3 -I -c`.
 *
 * The supervisor first creates private Linux user, PID, and mount namespaces
 * and mounts a fresh procfs.  It then drops and locks all capabilities before
 * starting untrusted hook code, preventing hooks from seeing the credential-
 * bearing action process or uncovering the host procfs.  It also becomes a
 * verified child subreaper and emits a clean protocol record only after waitpid
 * reports ECHILD.
 */
export const HOOK_SUPERVISOR_SCRIPT = String.raw`
import ctypes
import os
import re
import signal
import stat
import subprocess
import sys
import time

CLONE_NEWNS = 0x00020000
CLONE_NEWUSER = 0x10000000
CLONE_NEWPID = 0x20000000
LINUX_CAPABILITY_VERSION_3 = 0x20080522
MS_PRIVATE = 1 << 18
MS_REC = 1 << 14
MS_BIND = 1 << 12
MS_NODEV = 1 << 2
MS_NOEXEC = 1 << 3
MS_NOSUID = 1 << 1
PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECUREBITS = 28
PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
SECBIT_NOROOT = 1 << 0
SECBIT_NOROOT_LOCKED = 1 << 1
PROTOCOL_FD = 3
TERM_GRACE_SECONDS = 0.5
KILL_GRACE_SECONDS = 4.0
KNOWN_CONTAINER_SOCKET_PATHS = (
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/docker-host.sock",
    "/var/run/docker-host.sock",
    "/run/host-services/docker.proxy.sock",
    "/run/containerd/containerd.sock",
    "/var/run/containerd/containerd.sock",
    "/run/k3s/containerd/containerd.sock",
    "/run/podman/podman.sock",
    "/var/run/podman/podman.sock",
    "/run/crio/crio.sock",
    "/var/run/crio/crio.sock",
)

libc = ctypes.CDLL(None, use_errno=True)

class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

class CapabilityData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]

def protocol(record):
    os.write(PROTOCOL_FD, (record + "\n").encode("ascii"))

def checked_call(result, operation):
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, "%s: %s" % (operation, os.strerror(error)))

def write_mapping(path, value):
    with open(path, "w", encoding="ascii") as mapping:
        mapping.write(value)

def decode_mount_path(value):
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )

def proc_mountpoints():
    mountpoints = []
    with open("/proc/self/mountinfo", "r", encoding="utf8") as mounts:
        for record in mounts:
            left, separator, right = record.partition(" - ")
            if not separator or right.split()[0] != "proc":
                continue
            fields = left.split()
            if len(fields) < 5:
                raise RuntimeError("invalid procfs mountinfo record")
            mountpoints.append(decode_mount_path(fields[4]))
    if "/proc" not in mountpoints:
        raise RuntimeError("primary procfs mount was not found")
    return tuple(dict.fromkeys(mountpoints))

def container_socket_paths(host_uid):
    candidates = list(KNOWN_CONTAINER_SOCKET_PATHS)
    candidates.extend(
        (
            "/run/user/%d/podman/podman.sock" % host_uid,
            "/var/run/user/%d/podman/podman.sock" % host_uid,
            "/run/user/%d/docker.sock" % host_uid,
            "/var/run/user/%d/docker.sock" % host_uid,
            "/run/user/%d/containerd/containerd.sock" % host_uid,
            "/var/run/user/%d/containerd/containerd.sock" % host_uid,
        )
    )
    paths = []
    for path in candidates:
        if not os.path.lexists(path):
            continue
        resolved = os.path.realpath(path)
        if not stat.S_ISSOCK(os.stat(resolved, follow_symlinks=False).st_mode):
            raise RuntimeError("known container endpoint is not a socket: " + path)
        paths.append(resolved)
    return tuple(dict.fromkeys(paths))

def mount_tmpfs(path):
    checked_call(
        libc.mount(
            b"tmpfs",
            os.fsencode(path),
            b"tmpfs",
            MS_NOSUID | MS_NODEV | MS_NOEXEC,
            b"size=4096,mode=000",
        ),
        "mask mount " + path,
    )

def mask_host_interfaces(inherited_proc_mounts, container_sockets):
    checked_call(
        libc.mount(None, b"/", None, MS_REC | MS_PRIVATE, None),
        "make mounts private",
    )
    checked_call(
        libc.mount(b"proc", b"/proc", b"proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, None),
        "mount private procfs",
    )
    for mountpoint in inherited_proc_mounts:
        if mountpoint == "/proc" or mountpoint.startswith("/proc/"):
            continue
        mount_tmpfs(mountpoint)
    for path in container_sockets:
        checked_call(
            libc.mount(b"/dev/null", os.fsencode(path), None, MS_BIND, None),
            "mask container endpoint " + path,
        )

    for mountpoint in inherited_proc_mounts:
        if mountpoint == "/proc" or mountpoint.startswith("/proc/"):
            continue
        if os.path.exists(os.path.join(mountpoint, "self", "mountinfo")):
            raise RuntimeError("alternate procfs remains visible: " + mountpoint)
    for path in container_sockets:
        if stat.S_ISSOCK(os.stat(path, follow_symlinks=False).st_mode):
            raise RuntimeError("container endpoint remains accessible: " + path)

def enter_private_namespaces(inherited_proc_mounts, container_sockets):
    host_uid = os.getuid()
    host_gid = os.getgid()
    checked_call(libc.unshare(CLONE_NEWUSER), "unshare user namespace")
    try:
        write_mapping("/proc/self/setgroups", "deny")
    except FileNotFoundError:
        pass
    write_mapping("/proc/self/uid_map", "0 %d 1" % host_uid)
    write_mapping("/proc/self/gid_map", "0 %d 1" % host_gid)
    checked_call(
        libc.unshare(CLONE_NEWNS | CLONE_NEWPID),
        "unshare mount and PID namespaces",
    )
    child = os.fork()
    if child != 0:
        while True:
            try:
                waited, status = os.waitpid(child, 0)
                if waited == child:
                    return os.waitstatus_to_exitcode(status)
            except InterruptedError:
                continue
    mask_host_interfaces(inherited_proc_mounts, container_sockets)
    if os.getpid() != 1:
        raise RuntimeError("private PID namespace did not assign init PID")
    return None

def drop_and_lock_capabilities():
    checked_call(
        libc.prctl(
            PR_SET_SECUREBITS,
            SECBIT_NOROOT | SECBIT_NOROOT_LOCKED,
            0,
            0,
            0,
        ),
        "lock root capability suppression",
    )
    header = CapabilityHeader(LINUX_CAPABILITY_VERSION_3, 0)
    data = (CapabilityData * 2)()
    checked_call(libc.capset(ctypes.byref(header), ctypes.byref(data)), "drop capabilities")
    checked_call(libc.capget(ctypes.byref(header), ctypes.byref(data)), "verify capabilities")
    if any(
        record.effective or record.permitted or record.inheritable
        for record in data
    ):
        raise RuntimeError("capabilities remain after drop")
    checked_call(
        libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0),
        "set no-new-privileges",
    )

def become_non_dumpable():
    checked_call(libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0), "set non-dumpable")
    if libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise RuntimeError("non-dumpable state was not retained")

def establish_subreaper():
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    enabled = ctypes.c_int(0)
    if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(enabled), 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if enabled.value != 1:
        raise RuntimeError("PR_GET_CHILD_SUBREAPER did not confirm setup")

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
    inherited_proc_mounts = proc_mountpoints()
    container_sockets = container_socket_paths(os.getuid())
    interrupted = [None]
    def handle_signal(signum, _frame):
        interrupted[0] = signum
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, handle_signal)

    namespace_parent_result = enter_private_namespaces(
        inherited_proc_mounts,
        container_sockets,
    )
    if namespace_parent_result is not None:
        return namespace_parent_result
    establish_subreaper()
    drop_and_lock_capabilities()
    become_non_dumpable()
    protocol("ISOLATED")
    protocol("NON_DUMPABLE")
    protocol("READY")

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
