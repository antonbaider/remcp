#!/usr/bin/env python3
"""ReMCP XDG RemoteDesktop + libei sender helper.

Owns the portal session and EIS file descriptor in one process so SCM_RIGHTS never
has to cross Node's net.Socket implementation. JSON-lines are used only between
this helper and the local ReMCP runtime.
"""
import ctypes
import json
import os
import select
import sys
import time

try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception as exc:
    print(json.dumps({"ready": False, "kind": "unsupported", "error": f"PyGObject/Gio unavailable: {exc}"}), flush=True)
    sys.exit(78)

PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE_IFACE = "org.freedesktop.portal.RemoteDesktop"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
DEVICE_TYPES = 1 | 2  # keyboard | pointer in the portal API

EI_CAP_POINTER = 1 << 0
EI_CAP_POINTER_ABSOLUTE = 1 << 1
EI_CAP_KEYBOARD = 1 << 2
EI_CAP_SCROLL = 1 << 4
EI_CAP_BUTTON = 1 << 5
EI_EVENT_CONNECT = 1
EI_EVENT_DISCONNECT = 2
EI_EVENT_SEAT_ADDED = 3
EI_EVENT_SEAT_REMOVED = 4
EI_EVENT_DEVICE_ADDED = 5
EI_EVENT_DEVICE_REMOVED = 6
EI_EVENT_DEVICE_PAUSED = 7
EI_EVENT_DEVICE_RESUMED = 8


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def deep_unwrap(value):
    if isinstance(value, GLib.Variant):
        return deep_unwrap(value.unpack())
    if isinstance(value, dict):
        return {str(k): deep_unwrap(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [deep_unwrap(v) for v in value]
    return value


def token(prefix):
    return f"{prefix}_{os.getpid()}_{time.monotonic_ns()}".replace("-", "_")


class Portal:
    def __init__(self, timeout_ms):
        self.timeout_ms = timeout_ms
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.context = GLib.MainContext.default()
        self.responses = {}
        self.session = None
        self.subscription = self.conn.signal_subscribe(
            PORTAL_NAME,
            REQUEST_IFACE,
            "Response",
            None,
            None,
            Gio.DBusSignalFlags.NONE,
            self._on_response,
        )

    def _on_response(self, _conn, _sender, object_path, _iface, _signal, params, _data=None):
        try:
            response, results = params.unpack()
            self.responses[object_path] = (int(response), deep_unwrap(results))
        except Exception as exc:
            self.responses[object_path] = (2, {"error": str(exc)})

    def _wait_response(self, request_path):
        deadline = time.monotonic() + self.timeout_ms / 1000.0
        while time.monotonic() < deadline:
            while self.context.pending():
                self.context.iteration(False)
            if request_path in self.responses:
                response, results = self.responses.pop(request_path)
                if response == 1:
                    raise RuntimeError("portal request cancelled")
                if response != 0:
                    raise RuntimeError(f"portal request denied (response {response})")
                return results
            self.context.iteration(False)
            time.sleep(0.01)
        raise TimeoutError(f"portal request timed out after {self.timeout_ms} ms")

    def request(self, method, params):
        reply = self.conn.call_sync(
            PORTAL_NAME,
            PORTAL_PATH,
            REMOTE_IFACE,
            method,
            params,
            GLib.VariantType.new("(o)"),
            Gio.DBusCallFlags.NONE,
            min(self.timeout_ms, 10000),
            None,
        )
        request_path = reply.unpack()[0]
        return self._wait_response(request_path)

    def open(self, restore_token="", parent_window=""):
        create_opts = {
            "handle_token": GLib.Variant("s", token("create")),
            "session_handle_token": GLib.Variant("s", token("session")),
        }
        created = self.request("CreateSession", GLib.Variant("(a{sv})", (create_opts,)))
        self.session = created.get("session_handle")
        if not isinstance(self.session, str) or not self.session.startswith("/"):
            raise RuntimeError("portal returned no session handle")

        select_opts = {
            "handle_token": GLib.Variant("s", token("select")),
            "types": GLib.Variant("u", DEVICE_TYPES),
            "persist_mode": GLib.Variant("u", 2),
        }
        if restore_token:
            select_opts["restore_token"] = GLib.Variant("s", restore_token)
        self.request("SelectDevices", GLib.Variant("(oa{sv})", (self.session, select_opts)))

        start_opts = {"handle_token": GLib.Variant("s", token("start"))}
        started = self.request("Start", GLib.Variant("(osa{sv})", (self.session, parent_window or "", start_opts)))
        devices = int(started.get("devices", 0))
        if devices & DEVICE_TYPES != DEVICE_TYPES:
            raise RuntimeError(f"portal did not grant keyboard and pointer access (devices={devices})")
        return devices, str(started.get("restore_token") or "")

    def connect_eis(self):
        if not self.session:
            raise RuntimeError("portal session is not open")
        reply, fd_list = self.conn.call_with_unix_fd_list_sync(
            PORTAL_NAME,
            PORTAL_PATH,
            REMOTE_IFACE,
            "ConnectToEIS",
            GLib.Variant("(oa{sv})", (self.session, {})),
            GLib.VariantType.new("(h)"),
            Gio.DBusCallFlags.NONE,
            min(self.timeout_ms, 10000),
            None,
            None,
        )
        handle = int(reply.unpack()[0])
        fd = fd_list.get(handle)
        if fd < 0:
            raise RuntimeError("ConnectToEIS returned an invalid file descriptor")
        return fd

    def close(self):
        if self.session:
            try:
                self.conn.call_sync(
                    PORTAL_NAME,
                    self.session,
                    SESSION_IFACE,
                    "Close",
                    None,
                    None,
                    Gio.DBusCallFlags.NONE,
                    3000,
                    None,
                )
            except Exception:
                pass
            self.session = None
        try:
            self.conn.signal_unsubscribe(self.subscription)
        except Exception:
            pass


class EiSender:
    def __init__(self, fd):
        self.lib = ctypes.CDLL("libei.so.1")
        c_void_p = ctypes.c_void_p
        self.lib.ei_new_sender.argtypes = [c_void_p]
        self.lib.ei_new_sender.restype = c_void_p
        self.lib.ei_configure_name.argtypes = [c_void_p, ctypes.c_char_p]
        self.lib.ei_setup_backend_fd.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_setup_backend_fd.restype = ctypes.c_int
        self.lib.ei_get_fd.argtypes = [c_void_p]
        self.lib.ei_get_fd.restype = ctypes.c_int
        self.lib.ei_dispatch.argtypes = [c_void_p]
        self.lib.ei_get_event.argtypes = [c_void_p]
        self.lib.ei_get_event.restype = c_void_p
        self.lib.ei_event_get_type.argtypes = [c_void_p]
        self.lib.ei_event_get_type.restype = ctypes.c_int
        self.lib.ei_event_get_seat.argtypes = [c_void_p]
        self.lib.ei_event_get_seat.restype = c_void_p
        self.lib.ei_event_get_device.argtypes = [c_void_p]
        self.lib.ei_event_get_device.restype = c_void_p
        self.lib.ei_event_unref.argtypes = [c_void_p]
        self.lib.ei_event_unref.restype = c_void_p
        self.lib.ei_device_ref.argtypes = [c_void_p]
        self.lib.ei_device_ref.restype = c_void_p
        self.lib.ei_device_unref.argtypes = [c_void_p]
        self.lib.ei_device_unref.restype = c_void_p
        self.lib.ei_device_has_capability.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_device_has_capability.restype = ctypes.c_bool
        self.lib.ei_device_get_region_at.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_get_region_at.restype = c_void_p
        self.lib.ei_region_convert_point.argtypes = [c_void_p, ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)]
        self.lib.ei_region_convert_point.restype = ctypes.c_bool
        self.lib.ei_device_start_emulating.argtypes = [c_void_p, ctypes.c_uint32]
        self.lib.ei_device_stop_emulating.argtypes = [c_void_p]
        self.lib.ei_device_keyboard_key.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_bool]
        self.lib.ei_device_pointer_motion.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_pointer_motion_absolute.argtypes = [c_void_p, ctypes.c_double, ctypes.c_double]
        self.lib.ei_device_button_button.argtypes = [c_void_p, ctypes.c_uint32, ctypes.c_bool]
        self.lib.ei_device_scroll_discrete.argtypes = [c_void_p, ctypes.c_int32, ctypes.c_int32]
        self.lib.ei_device_frame.argtypes = [c_void_p, ctypes.c_uint64]
        self.lib.ei_now.argtypes = [c_void_p]
        self.lib.ei_now.restype = ctypes.c_uint64
        self.lib.ei_unref.argtypes = [c_void_p]
        self.lib.ei_unref.restype = c_void_p
        self.lib.ei_seat_has_capability.argtypes = [c_void_p, ctypes.c_int]
        self.lib.ei_seat_has_capability.restype = ctypes.c_bool
        # ei_seat_bind_capabilities is varargs: keep argtypes unset.
        self.lib.ei_seat_bind_capabilities.restype = None

        self.ei = self.lib.ei_new_sender(None)
        if not self.ei:
            raise RuntimeError("ei_new_sender failed")
        self.lib.ei_configure_name(self.ei, b"ReMCP")
        rc = int(self.lib.ei_setup_backend_fd(self.ei, fd))
        if rc < 0:
            raise RuntimeError(f"ei_setup_backend_fd failed ({rc})")
        self.fd = int(self.lib.ei_get_fd(self.ei))
        if self.fd < 0:
            raise RuntimeError("ei_get_fd failed")
        self.devices = {}
        self.sequence = 1
        self.connected = False
        self.pointer_device_key = None
        self.pointer_position = None
        # A press/release pair must stay on the same emulated device even if
        # absolute motion crosses an EIS region and changes pointer_device_key.
        self.button_device_keys = {}

    def _device_key(self, ptr):
        return int(ptr or 0)

    def _remember_device(self, ptr):
        key = self._device_key(ptr)
        if not key:
            return None
        if key not in self.devices:
            retained = self.lib.ei_device_ref(ptr)
            self.devices[key] = {"ptr": retained, "resumed": False, "emulating": False}
        return self.devices[key]

    def _drop_device(self, ptr):
        key = self._device_key(ptr)
        state = self.devices.pop(key, None)
        if key == self.pointer_device_key:
            self.pointer_device_key = None
            self.pointer_position = None
        for button, device_key in list(self.button_device_keys.items()):
            if device_key == key:
                self.button_device_keys.pop(button, None)
        if state:
            if state["emulating"]:
                try:
                    self.lib.ei_device_stop_emulating(state["ptr"])
                except Exception:
                    pass
            self.lib.ei_device_unref(state["ptr"])

    def _bind_seat(self, seat):
        caps = [EI_CAP_POINTER, EI_CAP_POINTER_ABSOLUTE, EI_CAP_KEYBOARD, EI_CAP_SCROLL, EI_CAP_BUTTON]
        args = [ctypes.c_void_p(seat)]
        args.extend(ctypes.c_int(cap) for cap in caps if self.lib.ei_seat_has_capability(seat, cap))
        args.append(ctypes.c_void_p())
        self.lib.ei_seat_bind_capabilities(*args)

    def process_events(self):
        self.lib.ei_dispatch(self.ei)
        while True:
            event = self.lib.ei_get_event(self.ei)
            if not event:
                break
            try:
                event_type = int(self.lib.ei_event_get_type(event))
                if event_type == EI_EVENT_CONNECT:
                    self.connected = True
                elif event_type == EI_EVENT_DISCONNECT:
                    raise RuntimeError("EIS server disconnected")
                elif event_type == EI_EVENT_SEAT_ADDED:
                    seat = self.lib.ei_event_get_seat(event)
                    if seat:
                        self._bind_seat(seat)
                elif event_type == EI_EVENT_DEVICE_ADDED:
                    device = self.lib.ei_event_get_device(event)
                    if device:
                        self._remember_device(device)
                elif event_type == EI_EVENT_DEVICE_RESUMED:
                    device = self.lib.ei_event_get_device(event)
                    state = self._remember_device(device)
                    if state:
                        state["resumed"] = True
                        if not state["emulating"]:
                            self.lib.ei_device_start_emulating(state["ptr"], self.sequence)
                            self.sequence = (self.sequence + 1) & 0xFFFFFFFF or 1
                            state["emulating"] = True
                elif event_type == EI_EVENT_DEVICE_PAUSED:
                    device = self.lib.ei_event_get_device(event)
                    key = self._device_key(device)
                    state = self.devices.get(key)
                    if state:
                        state["resumed"] = False
                        state["emulating"] = False
                    for button, device_key in list(self.button_device_keys.items()):
                        if device_key == key:
                            self.button_device_keys.pop(button, None)
                elif event_type == EI_EVENT_DEVICE_REMOVED:
                    self._drop_device(self.lib.ei_event_get_device(event))
            finally:
                self.lib.ei_event_unref(event)

    def wait_ready(self, timeout_s=10.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if (
                self.connected
                and self.capability_ready(EI_CAP_KEYBOARD)
                and self.capability_ready(EI_CAP_POINTER)
                and self.capability_ready(EI_CAP_BUTTON)
                and self.capability_ready(EI_CAP_SCROLL)
            ):
                return
            readable, _, _ = select.select([self.fd], [], [], min(0.1, max(0.0, deadline - time.monotonic())))
            if readable:
                self.process_events()
        raise TimeoutError(f"EIS devices did not become ready; capabilities={self.capabilities()}")

    def capability_ready(self, cap):
        return any(state["resumed"] and self.lib.ei_device_has_capability(state["ptr"], cap) for state in self.devices.values())

    def capabilities(self):
        names = {
            EI_CAP_POINTER: "pointer",
            EI_CAP_POINTER_ABSOLUTE: "pointer_absolute",
            EI_CAP_KEYBOARD: "keyboard",
            EI_CAP_SCROLL: "scroll",
            EI_CAP_BUTTON: "button",
        }
        return {name: self.capability_ready(cap) for cap, name in names.items()}

    def device_for(self, cap):
        for state in self.devices.values():
            if state["resumed"] and state["emulating"] and self.lib.ei_device_has_capability(state["ptr"], cap):
                return state["ptr"]
        raise RuntimeError(f"no resumed EIS device with capability {cap}")

    def _absolute_motion_for_device(self, device, x, y):
        if not self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
            return None
        region = self.lib.ei_device_get_region_at(device, float(x), float(y))
        if not region:
            return None
        motion_x = ctypes.c_double(float(x))
        motion_y = ctypes.c_double(float(y))
        if not self.lib.ei_region_convert_point(region, ctypes.byref(motion_x), ctypes.byref(motion_y)):
            raise RuntimeError(f"failed to convert desktop coordinate ({x}, {y}) into the selected EIS region")
        return motion_x.value, motion_y.value

    def device_for_absolute(self, x, y):
        candidates = []

        # Preserve pointer identity across absolute motion whenever the current
        # device still covers the destination. This is required for pointer
        # capture during drags: switching EIS devices mid-gesture can drop the
        # captured pointer before its button release is observed.
        preferred = self.devices.get(self.pointer_device_key)
        if preferred and preferred["resumed"] and preferred["emulating"]:
            device = preferred["ptr"]
            if self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
                candidates.append(device)
                converted = self._absolute_motion_for_device(device, x, y)
                if converted is not None:
                    return device, converted[0], converted[1]

        for state in self.devices.values():
            if not state["resumed"] or not state["emulating"]:
                continue
            device = state["ptr"]
            if preferred and self._device_key(device) == self.pointer_device_key:
                continue
            if not self.lib.ei_device_has_capability(device, EI_CAP_POINTER_ABSOLUTE):
                continue
            candidates.append(device)
            converted = self._absolute_motion_for_device(device, x, y)
            if converted is not None:
                return device, converted[0], converted[1]
        if candidates:
            raise RuntimeError(f"no absolute-pointer EIS region contains desktop coordinate ({x}, {y})")
        raise RuntimeError("no resumed EIS device with absolute-pointer capability")

    def device_for_pointer_context(self, cap):
        state = self.devices.get(self.pointer_device_key)
        if (
            state
            and state["resumed"]
            and state["emulating"]
            and self.lib.ei_device_has_capability(state["ptr"], cap)
        ):
            return state["ptr"]
        if self.pointer_position is not None:
            x, y = self.pointer_position
            for candidate in self.devices.values():
                if not candidate["resumed"] or not candidate["emulating"]:
                    continue
                device = candidate["ptr"]
                if not self.lib.ei_device_has_capability(device, cap):
                    continue
                if self.lib.ei_device_get_region_at(device, float(x), float(y)):
                    return device
        return self.device_for(cap)

    def remember_pointer(self, device, position=None):
        self.pointer_device_key = self._device_key(device)
        self.pointer_position = position

    def frame(self, device):
        self.lib.ei_device_frame(device, self.lib.ei_now(self.ei))

    def command(self, payload):
        op = str(payload.get("op") or "")
        if op == "key":
            device = self.device_for(EI_CAP_KEYBOARD)
            self.lib.ei_device_keyboard_key(device, int(payload["keycode"]), bool(payload.get("pressed")))
            self.frame(device)
        elif op == "motion":
            device = self.device_for(EI_CAP_POINTER)
            self.lib.ei_device_pointer_motion(device, float(payload.get("dx", 0)), float(payload.get("dy", 0)))
            self.remember_pointer(device)
            self.frame(device)
        elif op == "motion_absolute":
            x = float(payload["x"])
            y = float(payload["y"])
            device, motion_x, motion_y = self.device_for_absolute(x, y)
            self.lib.ei_device_pointer_motion_absolute(device, motion_x, motion_y)
            self.remember_pointer(device, (x, y))
            self.frame(device)
        elif op == "button":
            button = int(payload["button"])
            pressed = bool(payload.get("pressed"))
            if pressed:
                device = self.device_for_pointer_context(EI_CAP_BUTTON)
                self.button_device_keys[button] = self._device_key(device)
            else:
                key = self.button_device_keys.pop(button, None)
                state = self.devices.get(key) if key else None
                if (
                    state
                    and state["resumed"]
                    and state["emulating"]
                    and self.lib.ei_device_has_capability(state["ptr"], EI_CAP_BUTTON)
                ):
                    device = state["ptr"]
                else:
                    device = self.device_for_pointer_context(EI_CAP_BUTTON)
            self.lib.ei_device_button_button(device, button, pressed)
            self.frame(device)
        elif op == "scroll":
            device = self.device_for_pointer_context(EI_CAP_SCROLL)
            self.lib.ei_device_scroll_discrete(device, int(payload.get("dx", 0)), int(payload.get("dy", 0)))
            self.frame(device)
        elif op == "ping":
            pass
        elif op == "close":
            return False
        else:
            raise ValueError(f"unsupported EIS operation: {op}")
        return True

    def close(self):
        for state in list(self.devices.values()):
            if state["emulating"]:
                try:
                    self.lib.ei_device_stop_emulating(state["ptr"])
                except Exception:
                    pass
            try:
                self.lib.ei_device_unref(state["ptr"])
            except Exception:
                pass
        self.devices.clear()
        self.button_device_keys.clear()
        if self.ei:
            self.lib.ei_unref(self.ei)
            self.ei = None


def main():
    timeout_ms = max(1000, min(120000, int(os.environ.get("REMCP_EIS_TIMEOUT_MS", "30000"))))
    restore_token = os.environ.get("REMCP_EIS_RESTORE_TOKEN", "")
    parent_window = os.environ.get("REMCP_EIS_PARENT_WINDOW", "")
    portal = None
    sender = None
    try:
        portal = Portal(timeout_ms)
        devices, new_restore_token = portal.open(restore_token, parent_window)
        eis_fd = portal.connect_eis()
        sender = EiSender(eis_fd)
        sender.wait_ready(min(10.0, timeout_ms / 1000.0))
        emit({
            "ready": True,
            "backend": "xdg-eis",
            "devices": devices,
            "restore_token": new_restore_token,
            "capabilities": sender.capabilities(),
        })

        running = True
        while running:
            readable, _, _ = select.select([sys.stdin, sender.fd], [], [], 0.5)
            if sender.fd in readable:
                sender.process_events()
            if sys.stdin in readable:
                line = sys.stdin.readline()
                if line == "":
                    break
                request = None
                try:
                    request = json.loads(line)
                    request_id = request.get("id")
                    running = sender.command(request)
                    emit({"id": request_id, "ok": True, "capabilities": sender.capabilities()})
                except Exception as exc:
                    emit({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(exc)})
    except OSError as exc:
        emit({"ready": False, "kind": "unsupported", "error": f"libei unavailable: {exc}"})
        return 78
    except Exception as exc:
        emit({"ready": False, "kind": "runtime", "error": str(exc)})
        return 1
    finally:
        if sender:
            sender.close()
        if portal:
            portal.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
