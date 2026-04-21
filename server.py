#!/usr/bin/env python3
"""
Time Tracker - Local Server
Serves the static files and provides API endpoints to save/load
the SQLite database to/from a file on disk.
This ensures data persists across different browsers.

Usage:
    python server.py
    Then open http://localhost:8765 in any browser.
"""

import http.server
import json
import os
import sys
import webbrowser
import threading

PORT = 8765
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "timetracker.sqlite")

class TimeTrackerHandler(http.server.SimpleHTTPRequestHandler):
    """Custom handler that serves static files and handles DB API."""

    def __init__(self, *args, **kwargs):
        # Serve files from the script's directory
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

    def do_GET(self):
        if self.path == '/api/db':
            self.serve_db()
        elif self.path == '/api/db/version':
            self.serve_db_version()
        elif self.path == '/api/status':
            self.send_json({"status": "ok", "db_exists": os.path.exists(DB_FILE)})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/db':
            self.save_db()
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def serve_db_version(self):
        """Return the DB file's modification timestamp for change detection."""
        if os.path.exists(DB_FILE):
            mtime = os.path.getmtime(DB_FILE)
            size = os.path.getsize(DB_FILE)
            self.send_json({"version": mtime, "size": size})
        else:
            self.send_json({"version": 0, "size": 0})

    def serve_db(self):
        """Send the SQLite database file to the client."""
        if os.path.exists(DB_FILE):
            with open(DB_FILE, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "No database file found"}).encode())

    def save_db(self):
        """Save the SQLite database from the client to disk."""
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            self.send_json({"error": "No data received"}, status=400)
            return

        data = self.rfile.read(content_length)

        # Write to file
        with open(DB_FILE, 'wb') as f:
            f.write(data)

        size_kb = len(data) / 1024
        print(f"  [DB] Saved {size_kb:.1f} KB to {DB_FILE}")
        self.send_json({"success": True, "size": len(data)})

    def send_json(self, obj, status=200):
        """Send a JSON response."""
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, format, *args):
        # Only log API calls, not static file requests
        if '/api/' in str(args[0]):
            super().log_message(format, *args)


def main():
    print(f"""
╔══════════════════════════════════════════╗
║        🕐 Time Tracker Server           ║
╠══════════════════════════════════════════╣
║  URL:  http://localhost:{PORT}              ║
║  DB:   {os.path.basename(DB_FILE):36s} ║
║  Dir:  {os.path.dirname(DB_FILE)[:36]:36s} ║
╠══════════════════════════════════════════╣
║  Data persists across ALL browsers!     ║
║  Press Ctrl+C to stop the server.       ║
╚══════════════════════════════════════════╝
    """)

    server = http.server.HTTPServer(('0.0.0.0', PORT), TimeTrackerHandler)

    # Auto-open browser
    def open_browser():
        webbrowser.open(f'http://localhost:{PORT}')
    threading.Timer(1.0, open_browser).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()


if __name__ == '__main__':
    main()