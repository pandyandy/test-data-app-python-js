from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
from datetime import datetime, timedelta
import random


class VisualizationHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.serve_html()
        elif self.path == "/api/data/sales":
            self.serve_sales_data()
        elif self.path == "/api/data/users":
            self.serve_users_data()
        elif self.path == "/api/data/revenue":
            self.serve_revenue_data()
        elif self.path.startswith("/static/"):
            self.serve_static_file()
        else:
            self.send_error(404, "Not Found")

    def serve_html(self):
        try:
            html_path = os.path.join(os.path.dirname(__file__), "templates", "index.html")
            with open(html_path, "r", encoding="utf-8") as f:
                html_content = f.read()
            
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html_content.encode("utf-8"))
        except FileNotFoundError:
            self.send_error(404, "HTML file not found")

    def serve_static_file(self):
        file_path = self.path.lstrip("/")
        file_path = os.path.join(os.path.dirname(__file__), file_path)
        
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            
            content_type = "application/octet-stream"
            if file_path.endswith(".css"):
                content_type = "text/css"
            elif file_path.endswith(".js"):
                content_type = "application/javascript"
            
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_error(404, "File not found")

    def serve_sales_data(self):
        # Generate dummy sales data for the last 12 months
        data = []
        base_date = datetime.now()
        
        for i in range(12):
            date = base_date - timedelta(days=30 * (11 - i))
            data.append({
                "month": date.strftime("%Y-%m"),
                "sales": random.randint(5000, 25000),
                "orders": random.randint(100, 500)
            })
        
        self.send_json_response(data)

    def serve_users_data(self):
        # Generate dummy user growth data
        data = []
        base_date = datetime.now()
        base_users = 1000
        
        for i in range(30):
            date = base_date - timedelta(days=29 - i)
            growth = random.randint(10, 50)
            base_users += growth
            data.append({
                "date": date.strftime("%Y-%m-%d"),
                "users": base_users,
                "new_users": growth
            })
        
        self.send_json_response(data)

    def serve_revenue_data(self):
        # Generate dummy revenue data by category
        categories = ["Electronics", "Clothing", "Food", "Books", "Toys"]
        data = []
        
        for category in categories:
            data.append({
                "category": category,
                "revenue": random.randint(10000, 100000),
                "growth": round(random.uniform(-15, 30), 2)
            })
        
        self.send_json_response(data)

    def send_json_response(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def log_message(self, format, *args):
        # Custom log format
        print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} - {format % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8050), VisualizationHandler)
    print("Visualization server running on port 8050")
    print("Open http://localhost:8050 in your browser")
    server.serve_forever()
