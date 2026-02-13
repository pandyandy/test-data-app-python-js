from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os


class VisualizationHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]  # Remove query parameters
        
        if path == '/api/data':
            # Return dummy data as JSON
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            dummy_data = {
                "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                "sales": [4500, 5200, 4800, 6100, 5500, 7200, 6800, 7500, 6900, 8100, 7800, 9200],
                "visitors": [1200, 1500, 1300, 1800, 1600, 2100, 2000, 2300, 2200, 2500, 2400, 2800],
                "revenue": [12500, 14500, 13200, 16800, 15200, 19800, 18500, 21000, 19500, 22500, 21800, 25500]
            }
            
            self.wfile.write(json.dumps(dummy_data).encode())
        else:
            # Serve static files
            if path == '/' or path == '/index.html':
                file_path = 'static/index.html'
            elif path.startswith('/static/'):
                file_path = path[1:]  # Remove leading /
            else:
                file_path = 'static' + path
            
            # Security: prevent directory traversal
            if '..' in file_path:
                self.send_error(403, "Forbidden")
                return
            
            try:
                if os.path.exists(file_path) and os.path.isfile(file_path):
                    with open(file_path, 'rb') as f:
                        content = f.read()
                    
                    # Determine content type
                    if file_path.endswith('.html'):
                        content_type = 'text/html; charset=utf-8'
                    elif file_path.endswith('.css'):
                        content_type = 'text/css'
                    elif file_path.endswith('.js'):
                        content_type = 'application/javascript'
                    elif file_path.endswith('.json'):
                        content_type = 'application/json'
                    else:
                        content_type = 'application/octet-stream'
                    
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.end_headers()
                    self.wfile.write(content)
                else:
                    self.send_error(404, "File not found")
            except Exception as e:
                self.send_error(500, f"Server error: {str(e)}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8050), VisualizationHandler)
    print("Visualization app running on http://0.0.0.0:8050")
    server.serve_forever()
