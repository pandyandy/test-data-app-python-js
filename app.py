from http.server import HTTPServer, BaseHTTPRequestHandler


class HelloHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<h1>Hello World</h1>\n")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8050), HelloHandler)
    print("Server running on port 8050")
    server.serve_forever()
