from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from pathlib import Path
import json
import gzip
import zlib

ROOT = Path(__file__).parent
gift_tiers_cache = None


class RocketHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.proxy_request()
        requested = ROOT / self.path.lstrip("/").split("?", 1)[0]
        if not requested.exists() and (self.path.startswith("/epic/") or self.path.startswith("/assets/")):
            return self.proxy_static_asset()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.proxy_request()
        return super().do_POST()

    def proxy_request(self):
        request_path = self.path.split("?", 1)[0].rstrip("/")
        if request_path == "/api/rocket/gift-tiers":
            global gift_tiers_cache
            try:
                with urlopen("https://hello-problem-solver-2.replit.app/api/rocket/gift-tiers") as response:
                    payload = response.read()
                gift_tiers_cache = json.loads(payload)
                self.send_json(payload)
            except Exception as error:
                self.send_error(502, str(error))
            return
        if request_path.startswith("/api/gift-image/"):
            return self.proxy_gift_image(request_path)
        if request_path == "/api/gifts" or request_path.startswith("/api/gifts/"):
            payload = b'[{"id":"vice-cream-demo","name":"Vice Cream","model_name":"Vice Cream","price":4.08,"price_ton":"4.08","priceTon":4.08,"status":"available","imageUrl":"https://cdn.changes.tg/gifts/models/vice-cream.webp","backdropName":null}]'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if request_path == "/api/wallet/balance" or request_path.startswith("/api/wallet/balance/"):
            payload = b'{"availableTON":"1000","balanceTON":"1000","starsBalance":"0"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None
        target = "https://hello-problem-solver-2.replit.app" + self.path
        # Never forward the browser's Accept-Encoding: the remote may answer
        # gzip/brotli, and passing those raw bytes through without the
        # Content-Encoding header corrupts JSON responses (e.g. gift tiers).
        headers = {
            key: value for key, value in self.headers.items()
            if key.lower() not in {"host", "accept-encoding"}
        }
        try:
            with urlopen(Request(target, data=body, headers=headers, method=self.command)) as response:
                payload = response.read()
                encoding = (response.headers.get("Content-Encoding") or "").strip().lower()
                if encoding == "gzip":
                    try:
                        payload = gzip.decompress(payload)
                    except OSError:
                        pass
                elif encoding == "deflate":
                    try:
                        payload = zlib.decompress(payload)
                    except zlib.error:
                        try:
                            payload = zlib.decompress(payload, -zlib.MAX_WBITS)
                        except zlib.error:
                            pass
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() not in {"transfer-encoding", "connection", "content-encoding", "content-length"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except Exception as error:
            self.send_error(502, str(error))

    def send_json(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def proxy_gift_image(self, request_path):
        global gift_tiers_cache
        try:
            if gift_tiers_cache is None:
                with urlopen("https://hello-problem-solver-2.replit.app/api/rocket/gift-tiers") as response:
                    gift_tiers_cache = json.loads(response.read())
            image_path = request_path.removeprefix("/api/gift-image/")
            gift = next((item for item in gift_tiers_cache.get("gifts", []) if str(item.get("imageUrl", "")).endswith(image_path)), None)
            if not gift or not gift.get("sourceUrl"):
                self.send_error(404, "Gift image not found")
                return
            with urlopen(gift["sourceUrl"]) as response:
                payload = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get_content_type())
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except Exception as error:
            self.send_error(502, str(error))

    def proxy_static_asset(self):
        target = "https://hello-problem-solver-2.replit.app" + self.path
        try:
            with urlopen(target) as response:
                payload = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get_content_type())
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except Exception as error:
            self.send_error(502, str(error))


ThreadingHTTPServer(("", 8001), RocketHandler).serve_forever()
