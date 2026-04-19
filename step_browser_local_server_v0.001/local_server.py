import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / 'step_browser_local_server_config.json'
PID_PATH = BASE_DIR / 'server_state.json'

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8080,
    "serve_parent_of_helper_folder": True,
    "serve_root_override": "",
    "default_app_relative_url": "/step_browser_poc_v0.222/step_browser_poc_v0.222.html",
    "open_browser_on_start": True
}


def load_config():
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding='utf-8')
        return DEFAULT_CONFIG.copy()
    data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    cfg = DEFAULT_CONFIG.copy()
    cfg.update(data)
    return cfg


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def resolve_serve_root(cfg):
    override = (cfg.get('serve_root_override') or '').strip()
    if override:
        return Path(override).expanduser().resolve()
    if cfg.get('serve_parent_of_helper_folder', True):
        return BASE_DIR.parent.resolve()
    return BASE_DIR.resolve()


def choose_handler(directory: str):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def end_headers(self):
            # Make local testing less annoying for wasm/worker loads.
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            super().end_headers()

        def log_message(self, fmt, *args):
            sys.stdout.write("[http] " + (fmt % args) + "\n")
            sys.stdout.flush()

    return Handler


def check_port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) != 0


def main():
    cfg = load_config()
    host = cfg['host']
    port = int(cfg['port'])
    serve_root = resolve_serve_root(cfg)
    if not serve_root.exists():
        raise SystemExit(f"Serve root does not exist: {serve_root}")

    if not check_port_free(host, port):
        print(f"Server already appears to be running on http://{host}:{port}")
        return

    os.chdir(serve_root)
    handler = choose_handler(str(serve_root))
    with ReusableTCPServer((host, port), handler) as httpd:
        state = {
            "host": host,
            "port": port,
            "serve_root": str(serve_root),
            "default_app_relative_url": cfg['default_app_relative_url'],
        }
        PID_PATH.write_text(json.dumps(state, indent=2), encoding='utf-8')
        full_url = f"http://{host}:{port}{cfg['default_app_relative_url']}"
        print(f"Serving: {serve_root}")
        print(f"Open app: {full_url}")
        if cfg.get('open_browser_on_start', True):
            threading.Timer(0.6, lambda: webbrowser.open(full_url)).start()
        try:
            httpd.serve_forever()
        finally:
            try:
                PID_PATH.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == '__main__':
    main()
