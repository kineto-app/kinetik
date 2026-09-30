from http.server import HTTPServer, SimpleHTTPRequestHandler
class Handler(SimpleHTTPRequestHandler):
 def end_headers(self):
  self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'self'")
  self.send_header('Cache-Control','no-store')
  super().end_headers()
HTTPServer(('127.0.0.1',18763),Handler).serve_forever()
