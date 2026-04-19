#!/usr/bin/env python3
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / 'step_export_helper_config.json'
DEFAULT_CONFIG = {
    'host': '127.0.0.1',
    'port': 8766,
    'jobs_dir': 'jobs',
    'ffmpeg_path': '',
    'browser_path': ''
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                cfg.update({k: data[k] for k in data.keys() if k in cfg})
        except Exception:
            pass
    return cfg


def resolve_jobs_dir(cfg):
    jobs_dir = ROOT / str(cfg.get('jobs_dir') or 'jobs')
    jobs_dir.mkdir(parents=True, exist_ok=True)
    return jobs_dir


def find_ffmpeg(cfg):
    configured = str(cfg.get('ffmpeg_path') or '').strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))
    candidates.extend([
        ROOT / 'ffmpeg' / 'bin' / 'ffmpeg.exe',
        ROOT / 'ffmpeg' / 'bin' / 'ffmpeg',
    ])
    for path in candidates:
        if path.exists():
            return str(path)
    found = shutil.which('ffmpeg')
    return found or ''



def find_browser(cfg):
    configured = str(cfg.get('browser_path') or '').strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))
    program_files = os.environ.get('ProgramFiles') or r'C:\Program Files'
    program_files_x86 = os.environ.get('ProgramFiles(x86)') or r'C:\Program Files (x86)'
    local_app = os.environ.get('LocalAppData') or ''
    candidates.extend([
        Path(program_files) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe',
        Path(program_files_x86) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe',
        Path(program_files) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe',
        Path(program_files_x86) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe',
    ])
    if local_app:
        candidates.extend([
            Path(local_app) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe',
            Path(local_app) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe',
        ])
    for name in ['msedge', 'chrome', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']:
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    seen = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.exists():
            return str(path)
    return ''


def build_text_plate_html(payload, width, height):
    radius = max(0, int(payload.get('radius') or 12))
    panel_fill = str(payload.get('panel_fill') or 'rgba(15,23,42,0.72)')
    panel_stroke = str(payload.get('panel_stroke') or 'rgba(148,163,184,0.42)')
    panel_stroke_width = max(0, float(payload.get('panel_stroke_width') or 1))
    overscan_right = max(0, int(payload.get('overscan_right') or 0))
    overscan_bottom = max(0, int(payload.get('overscan_bottom') or 0))
    total_width = max(1, width + overscan_right)
    total_height = max(1, height + overscan_bottom)
    pad_x = max(0, int(payload.get('content_padding_x') or 14))
    pad_top = max(0, int(payload.get('content_padding_top') or 16))
    pad_bottom = max(0, int(payload.get('content_padding_bottom') or 14))
    font_family = str(payload.get('font_family') or 'Arial, Helvetica, sans-serif')
    text_color = str(payload.get('text_color') or '#e5e7eb')
    base_font_size = max(8, int(payload.get('base_font_size') or 16))
    line_height = float(payload.get('line_height') or 1.45)
    text_scale = float(payload.get('text_scale') or 1.0)
    if not math.isfinite(text_scale):
        text_scale = 1.0
    text_scale = max(0.35, min(4.0, text_scale))
    inner_width = max(1, int(payload.get('inner_width') or math.ceil(width / text_scale)))
    inner_height = max(1, int(payload.get('inner_height') or math.ceil(height / text_scale)))
    html = str(payload.get('html') or '').strip()
    if not html:
        text_value = str(payload.get('plain_text') or '')
        html = '<p>' + text_value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('\n', '<br>') + '</p>'
    stroke_shadow = f"inset 0 0 0 {panel_stroke_width}px {panel_stroke}" if panel_stroke_width > 0 else 'none'
    return f'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{{margin:0;padding:0;width:{total_width}px;height:{total_height}px;background:transparent;overflow:hidden;}}
body{{font-family:{font_family};position:relative;}}
#plate{{position:absolute;left:0;top:0;width:{width}px;height:{height}px;box-sizing:border-box;background:{panel_fill};border:none;border-radius:{radius}px;overflow:visible;box-shadow:{stroke_shadow};}}
#contentScale{{width:{inner_width}px;min-height:{inner_height}px;transform:scale({text_scale});transform-origin:top left;box-sizing:border-box;overflow:visible;}}
#content{{width:100%;min-height:100%;height:auto;box-sizing:border-box;padding:{pad_top}px {pad_x}px {pad_bottom}px;color:{text_color};font-family:{font_family};font-size:{base_font_size}px;line-height:{line_height};overflow:visible;overflow-wrap:anywhere;word-break:break-word;white-space:normal;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}}
#content *{{max-width:100%;box-sizing:border-box;}}
#content p{{margin:.18em 0;}}
#content p:first-child{{margin-top:0;}}
#content p:last-child{{margin-bottom:0;}}
#content h1,#content h2,#content h3{{margin:.25em 0 .35em;line-height:1.2;}}
#content ul,#content ol{{margin:.2em 0;padding-left:20px;}}
#content strong,#content b{{font-weight:700;}}
#content em,#content i{{font-style:italic;}}
#content span{{white-space:pre-wrap;}}
#content .ql-align-center{{text-align:center;}}
#content .ql-align-right{{text-align:right;}}
#content .ql-align-justify{{text-align:justify;}}
#content .ql-size-small{{font-size:.75em;}}
#content .ql-size-large{{font-size:1.5em;}}
#content .ql-size-huge{{font-size:2.5em;}}
</style>
</head>
<body>
<div id="plate"><div id="contentScale"><div id="content">{html}</div></div></div>
</body>
</html>'''


def render_text_plate_with_playwright(browser_path, html_text, png_path, width, height, debug_log):
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        debug_log.append(f'Playwright import unavailable: {exc}')
        return False
    launch_args = []
    if os.name != 'nt':
        launch_args.append('--no-sandbox')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=browser_path or None, args=launch_args)
            page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            page.set_content(html_text, wait_until='load')
            page.screenshot(path=str(png_path), omit_background=True, scale='css')
            browser.close()
        return png_path.exists() and png_path.stat().st_size > 0
    except Exception as exc:
        debug_log.append(f'Playwright render failed: {exc}')
        return False


def render_text_plate_with_browser_cli(browser_path, html_path, png_path, width, height, debug_log):
    if not browser_path:
        debug_log.append('No browser executable found for CLI fallback.')
        return False
    common = [
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        '--allow-file-access-from-files',
        f'--window-size={width},{height}',
        f'--screenshot={png_path}',
        html_path.resolve().as_uri(),
    ]
    variants = [
        [browser_path, '--headless=new'],
        [browser_path, '--headless'],
    ]
    if os.name != 'nt':
        variants = [[browser_path, '--no-sandbox', *variant[1:]] for variant in variants]
    for prefix in variants:
        cmd = prefix + common
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            debug_log.append('CLI COMMAND: ' + ' '.join(cmd))
            debug_log.append('CLI STDOUT\n' + (proc.stdout or ''))
            debug_log.append('CLI STDERR\n' + (proc.stderr or ''))
            if proc.returncode == 0 and png_path.exists() and png_path.stat().st_size > 0:
                return True
        except Exception as exc:
            debug_log.append(f'CLI render failed: {exc}')
    return False


def render_text_plate(job_dir, payload, cfg):
    browser_path = find_browser(cfg)
    if not browser_path:
        raise RuntimeError('No supported browser was found for helper text plate rendering. Set browser_path in step_export_helper_config.json or install Chrome/Edge.')
    width = max(1, int(payload.get('width') or 1))
    height = max(1, int(payload.get('height') or 1))
    capture_width = max(1, width + max(0, int(payload.get('overscan_right') or 0)))
    capture_height = max(1, height + max(0, int(payload.get('overscan_bottom') or 0)))
    plate_id = os.path.basename(str(payload.get('plate_id') or uuid.uuid4().hex[:12])).replace('.png', '')
    src_dir = Path(job_dir) / 'text_plate_source'
    out_dir = Path(job_dir) / 'text_plates'
    logs_dir = Path(job_dir) / 'logs'
    src_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    html_path = src_dir / f'{plate_id}.html'
    png_path = out_dir / f'{plate_id}.png'
    html_text = build_text_plate_html(payload, width, height)
    html_path.write_text(html_text, encoding='utf-8')
    debug_log = [
        f'Browser: {browser_path}',
        f'Plate: {plate_id}',
        f'Visible size: {width}x{height}',
        f'Canvas size: {capture_width}x{capture_height}'
    ]
    ok = render_text_plate_with_playwright(browser_path, html_text, png_path, capture_width, capture_height, debug_log)
    if not ok:
        ok = render_text_plate_with_browser_cli(browser_path, html_path, png_path, capture_width, capture_height, debug_log)
    (logs_dir / f'text_plate_{plate_id}.log').write_text('\n\n'.join(debug_log), encoding='utf-8')
    if not ok:
        raise RuntimeError(f'Helper failed to render text plate {plate_id}. See text_plate_{plate_id}.log in the job logs folder.')
    return png_path

def json_bytes(payload, status=200):
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode('utf-8')
    headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': str(len(body)),
    }
    return status, headers, body


def file_bytes(path, mime='application/octet-stream'):
    data = Path(path).read_bytes()
    headers = {
        'Content-Type': mime,
        'Content-Length': str(len(data)),
    }
    return 200, headers, data


def build_ffmpeg_command(ffmpeg_path, job_dir, fps, output_filename='output.mp4'):
    frames_pattern = str(job_dir / 'frames' / 'frame_%05d.png')
    wav_path = job_dir / 'audio' / 'narration.wav'
    output_path = job_dir / 'output' / output_filename
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg_path, '-y', '-framerate', str(fps), '-i', frames_pattern]
    if wav_path.exists() and wav_path.stat().st_size > 0:
        cmd += ['-i', str(wav_path), '-map', '0:v:0', '-map', '1:a:0']
    else:
        cmd += ['-map', '0:v:0']
    cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']
    if wav_path.exists() and wav_path.stat().st_size > 0:
        cmd += ['-c:a', 'aac', '-b:a', '192k', '-shortest']
    cmd += ['-movflags', '+faststart', str(output_path)]
    return cmd, output_path


def write_job_meta(job_dir, payload):
    (job_dir / 'job.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def read_job_meta(job_dir):
    path = job_dir / 'job.json'
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def encode_job(job_dir, cfg, override_payload=None):
    ffmpeg_path = find_ffmpeg(cfg)
    if not ffmpeg_path:
        raise RuntimeError('FFmpeg was not found. Put ffmpeg.exe into ffmpeg\\bin next to this helper, or install FFmpeg globally.')
    job_dir = Path(job_dir)
    meta = read_job_meta(job_dir)
    if override_payload:
        meta.update(override_payload)
    fps = int(meta.get('fps') or 30)
    output_filename = str(meta.get('output_filename') or 'output.mp4')
    output_filename = os.path.basename(output_filename)
    cmd, output_path = build_ffmpeg_command(ffmpeg_path, job_dir, fps, output_filename=output_filename)
    logs_dir = job_dir / 'logs'
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / 'ffmpeg_output.log'
    proc = subprocess.run(cmd, capture_output=True, text=True)
    log_path.write_text(
        'COMMAND:\n' + ' '.join(cmd) + '\n\nSTDOUT:\n' + (proc.stdout or '') + '\n\nSTDERR:\n' + (proc.stderr or ''),
        encoding='utf-8'
    )
    if proc.returncode != 0:
        raise RuntimeError(f'FFmpeg failed with exit code {proc.returncode}. See {log_path.name} in the job logs folder.')
    meta['encoded'] = True
    meta['output_filename'] = output_filename
    meta['ffmpeg_path'] = ffmpeg_path
    write_job_meta(job_dir, meta)
    return output_path, log_path


class App:
    def __init__(self):
        self.cfg = load_config()
        self.jobs_dir = resolve_jobs_dir(self.cfg)


APP = App()


class Handler(BaseHTTPRequestHandler):
    server_version = 'StepExportHelper/0.141'

    def log_message(self, fmt, *args):
        sys.stdout.write('%s - - [%s] %s\n' % (self.address_string(), self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        super().end_headers()

    def _send(self, status, headers, body=b''):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length > 0 else b'{}'
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))

    def do_OPTIONS(self):
        self._send(204, {'Content-Length': '0'})

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split('/') if p]
        try:
            if parsed.path == '/health':
                ffmpeg_path = find_ffmpeg(APP.cfg)
                browser_path = find_browser(APP.cfg)
                payload = {
                    'ok': True,
                    'helper': 'step_export_helper_v0.141',
                    'jobs_dir': str(APP.jobs_dir),
                    'ffmpeg_found': bool(ffmpeg_path),
                    'ffmpeg_path': ffmpeg_path,
                    'browser_found': bool(browser_path),
                    'browser_path': browser_path,
                    'port': int(APP.cfg.get('port') or 8766)
                }
                return self._send(*json_bytes(payload))
            if len(parts) == 4 and parts[0] == 'jobs' and parts[2] == 'result':
                # handles /jobs/<id>/result because split removes empty and result path length is 3; keeping 4 safety not used
                pass
            if len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'result':
                job_id = unquote(parts[1])
                job_dir = APP.jobs_dir / job_id
                meta = read_job_meta(job_dir)
                output_filename = str(meta.get('output_filename') or 'output.mp4')
                output_path = job_dir / 'output' / output_filename
                if not output_path.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Encoded MP4 was not found for this job.'}, status=404))
                return self._send(*file_bytes(output_path, 'video/mp4'))
            if len(parts) == 4 and parts[0] == 'jobs' and parts[2] == 'text-plates':
                job_id = unquote(parts[1])
                filename = os.path.basename(unquote(parts[3]))
                plate_path = APP.jobs_dir / job_id / 'text_plates' / filename
                if not plate_path.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Text plate not found.'}, status=404))
                return self._send(*file_bytes(plate_path, 'image/png'))
            if len(parts) == 2 and parts[0] == 'jobs':
                job_id = unquote(parts[1])
                job_dir = APP.jobs_dir / job_id
                if not job_dir.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Job not found.'}, status=404))
                meta = read_job_meta(job_dir)
                frames = sorted((job_dir / 'frames').glob('frame_*.png'))
                payload = {
                    'ok': True,
                    'job_id': job_id,
                    'meta': meta,
                    'frame_count': len(frames),
                    'has_audio': (job_dir / 'audio' / 'narration.wav').exists(),
                    'output_exists': (job_dir / 'output' / str(meta.get('output_filename') or 'output.mp4')).exists(),
                }
                return self._send(*json_bytes(payload))
            return self._send(*json_bytes({'ok': False, 'error': 'Not found.'}, status=404))
        except Exception as exc:
            traceback.print_exc()
            return self._send(*json_bytes({'ok': False, 'error': str(exc)}, status=500))

    def do_POST(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split('/') if p]
        try:
            if parsed.path == '/jobs':
                payload = self._read_json()
                job_id = uuid.uuid4().hex[:12]
                job_dir = APP.jobs_dir / job_id
                (job_dir / 'frames').mkdir(parents=True, exist_ok=True)
                (job_dir / 'audio').mkdir(parents=True, exist_ok=True)
                (job_dir / 'output').mkdir(parents=True, exist_ok=True)
                (job_dir / 'logs').mkdir(parents=True, exist_ok=True)
                meta = {
                    'job_id': job_id,
                    'base_name': str(payload.get('base_name') or 'step_browser_export'),
                    'fps': int(payload.get('fps') or 30),
                    'width': int(payload.get('width') or 1920),
                    'height': int(payload.get('height') or 1080),
                    'frame_digits': int(payload.get('frame_digits') or 5),
                    'output_filename': str(payload.get('output_filename') or 'output.mp4')
                }
                write_job_meta(job_dir, meta)
                return self._send(*json_bytes({'ok': True, 'job_id': job_id, 'job_dir': str(job_dir)}))
            if len(parts) == 4 and parts[0] == 'jobs' and parts[2] == 'frames':
                job_id = unquote(parts[1])
                filename = os.path.basename(unquote(parts[3]))
                if not filename.lower().endswith('.png'):
                    return self._send(*json_bytes({'ok': False, 'error': 'Frame filename must end with .png'}, status=400))
                job_dir = APP.jobs_dir / job_id
                if not job_dir.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Job not found.'}, status=404))
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length) if length > 0 else b''
                if not body:
                    return self._send(*json_bytes({'ok': False, 'error': 'Frame upload body was empty.'}, status=400))
                frame_path = job_dir / 'frames' / filename
                frame_path.write_bytes(body)
                return self._send(*json_bytes({'ok': True, 'filename': filename, 'size': len(body)}))
            if len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'audio':
                job_id = unquote(parts[1])
                job_dir = APP.jobs_dir / job_id
                if not job_dir.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Job not found.'}, status=404))
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length) if length > 0 else b''
                if not body:
                    return self._send(*json_bytes({'ok': False, 'error': 'Narration WAV upload body was empty.'}, status=400))
                audio_path = job_dir / 'audio' / 'narration.wav'
                audio_path.write_bytes(body)
                return self._send(*json_bytes({'ok': True, 'size': len(body)}))
            if len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'text-plates':
                job_id = unquote(parts[1])
                job_dir = APP.jobs_dir / job_id
                if not job_dir.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Job not found.'}, status=404))
                payload = self._read_json()
                png_path = render_text_plate(job_dir, payload, APP.cfg)
                return self._send(*json_bytes({
                    'ok': True,
                    'plate_id': png_path.stem,
                    'plate_filename': png_path.name,
                    'plate_path': str(png_path),
                    'plate_url': f"/jobs/{job_id}/text-plates/{png_path.name}",
                    'draw_extra_right': max(0, int(payload.get('overscan_right') or 0)),
                    'draw_extra_bottom': max(0, int(payload.get('overscan_bottom') or 0))
                }))
            if len(parts) == 3 and parts[0] == 'jobs' and parts[2] == 'encode':
                job_id = unquote(parts[1])
                job_dir = APP.jobs_dir / job_id
                if not job_dir.exists():
                    return self._send(*json_bytes({'ok': False, 'error': 'Job not found.'}, status=404))
                payload = self._read_json()
                output_path, log_path = encode_job(job_dir, APP.cfg, override_payload=payload)
                return self._send(*json_bytes({'ok': True, 'job_id': job_id, 'output_path': str(output_path), 'log_path': str(log_path)}))
            return self._send(*json_bytes({'ok': False, 'error': 'Not found.'}, status=404))
        except Exception as exc:
            traceback.print_exc()
            return self._send(*json_bytes({'ok': False, 'error': str(exc)}, status=500))


def run_server():
    host = str(APP.cfg.get('host') or '127.0.0.1')
    port = int(APP.cfg.get('port') or 8766)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f'STEP export helper listening on http://{host}:{port}')
    print(f'Jobs folder: {APP.jobs_dir}')
    print(f'FFmpeg: {find_ffmpeg(APP.cfg) or "NOT FOUND"}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping helper...')
    finally:
        server.server_close()


def cli_check():
    ffmpeg_path = find_ffmpeg(APP.cfg)
    browser_path = find_browser(APP.cfg)
    print('STEP EXPORT HELPER CHECK')
    print('Root      :', ROOT)
    print('Jobs dir  :', APP.jobs_dir)
    print('FFmpeg    :', ffmpeg_path or 'NOT FOUND')
    print('Browser   :', browser_path or 'NOT FOUND')
    print('Host:Port :', f"{APP.cfg.get('host')}:{APP.cfg.get('port')}")
    return 0 if ffmpeg_path else 1


def cli_encode_job(job_path):
    output_path, log_path = encode_job(Path(job_path), APP.cfg)
    print('Encoded:', output_path)
    print('Log    :', log_path)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--encode-job', dest='encode_job', default='')
    args = parser.parse_args()
    if args.check:
        raise SystemExit(cli_check())
    if args.encode_job:
        raise SystemExit(cli_encode_job(args.encode_job))
    run_server()


if __name__ == '__main__':
    main()
