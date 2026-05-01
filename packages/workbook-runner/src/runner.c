// Workbook Runner — single-file polyglot workbook host.
//
// Build: cosmocc -O2 -o colorwave runner.c
// Result: a single APE binary (~3MB) that runs natively on
// Linux / macOS / Windows / FreeBSD without installation.
//
// Behavior on launch:
//   1. Bind a localhost HTTP server on a random free port
//   2. Open the user's default browser to http://localhost:<port>/
//   3. Serve the embedded workbook HTML on GET /
//   4. Accept saves via PUT /save (v0: writes sibling file; v1: self-rewrite)
//   5. Exit when browser disconnects or on SIGINT
//
// v0 scope (this commit):
//   - Embedded HTML payload via xxd-style include
//   - Single-threaded HTTP server (one client at a time, fine for one user)
//   - PUT /save writes to <argv[0]>.saved.html (NOT yet self-rewriting)
//   - Open browser via platform-specific command
//
// Future (v1+):
//   - True self-rewrite via APE's appended ZIP data section
//   - WebSocket for live status indicators
//   - Multi-target persistence (composition + sql data + assets)

#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>

#ifdef __COSMOPOLITAN__
#include <cosmo.h>
#endif

#include "payload.h"  // generated: const unsigned char workbook_html[]; const unsigned int workbook_html_len;

#define BUF_SIZE (4 * 1024 * 1024)
#define BIND_HOST "127.0.0.1"

static volatile sig_atomic_t running = 1;
static const char *self_path = NULL;

static void on_sigint(int signo) { (void)signo; running = 0; }

static int bind_random_port(int *out_port) {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock < 0) return -1;
  int yes = 1;
  setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  struct sockaddr_in addr = {0};
  addr.sin_family = AF_INET;
  inet_pton(AF_INET, BIND_HOST, &addr.sin_addr);
  addr.sin_port = 0;  // OS picks a free port
  if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    close(sock);
    return -1;
  }
  if (listen(sock, 8) < 0) {
    close(sock);
    return -1;
  }
  socklen_t addrlen = sizeof(addr);
  if (getsockname(sock, (struct sockaddr *)&addr, &addrlen) < 0) {
    close(sock);
    return -1;
  }
  *out_port = ntohs(addr.sin_port);
  return sock;
}

// Open the user's default browser. Per-platform; cosmopolitan binaries
// have access to all three so we just try fork+exec each.
static void open_browser(int port) {
  char url[64];
  snprintf(url, sizeof(url), "http://%s:%d/", BIND_HOST, port);
  fprintf(stderr, "[runner] opening %s\n", url);
  pid_t pid = fork();
  if (pid == 0) {
    // Try macOS open, then Linux xdg-open, then Windows start.
    execlp("open", "open", url, NULL);
    execlp("xdg-open", "xdg-open", url, NULL);
    execlp("cmd.exe", "cmd.exe", "/c", "start", url, NULL);
    fprintf(stderr, "[runner] could not launch browser; open %s manually\n", url);
    _exit(1);
  }
}

// Read until \r\n\r\n or EOF; returns header length or -1.
static ssize_t read_headers(int client, char *buf, size_t cap) {
  size_t off = 0;
  while (off < cap - 1) {
    ssize_t n = read(client, buf + off, cap - 1 - off);
    if (n <= 0) return -1;
    off += n;
    buf[off] = 0;
    if (strstr(buf, "\r\n\r\n")) return (ssize_t)off;
  }
  return -1;
}

// Case-insensitive substring (cosmocc lacks strcasestr in some builds).
static const char *ci_substr(const char *hay, const char *needle) {
  size_t nlen = strlen(needle);
  for (const char *p = hay; *p; p++) {
    if (strncasecmp(p, needle, nlen) == 0) return p;
  }
  return NULL;
}

// Parse Content-Length from headers; -1 if absent.
static long parse_content_length(const char *headers) {
  const char *p = ci_substr(headers, "Content-Length:");
  if (!p) return -1;
  p += strlen("Content-Length:");
  while (*p == ' ' || *p == '\t') p++;
  return atol(p);
}

static void write_all(int fd, const void *buf, size_t n) {
  const char *p = (const char *)buf;
  size_t left = n;
  while (left > 0) {
    ssize_t w = write(fd, p, left);
    if (w <= 0) return;
    p += w; left -= w;
  }
}

static void send_text(int client, int code, const char *status, const char *type, const char *body) {
  char hdr[512];
  size_t blen = body ? strlen(body) : 0;
  int n = snprintf(hdr, sizeof(hdr),
    "HTTP/1.1 %d %s\r\n"
    "Content-Type: %s\r\n"
    "Content-Length: %zu\r\n"
    "Cache-Control: no-store\r\n"
    "Connection: close\r\n"
    "\r\n",
    code, status, type, blen);
  write_all(client, hdr, n);
  if (body) write_all(client, body, blen);
}

static void send_binary(int client, const void *data, size_t len, const char *type) {
  char hdr[512];
  int n = snprintf(hdr, sizeof(hdr),
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: %s\r\n"
    "Content-Length: %zu\r\n"
    "Cache-Control: no-store\r\n"
    "Connection: close\r\n"
    "\r\n",
    type, len);
  write_all(client, hdr, n);
  write_all(client, data, len);
}

// Save the request body to <self_path>.saved.html. v0 — does not yet
// rewrite the binary itself; that's v1. Demonstrates the round-trip.
static int handle_save(const char *body, size_t len) {
  if (!self_path) return -1;
  char dst[4096];
  snprintf(dst, sizeof(dst), "%s.saved.html", self_path);
  int fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return -1;
  write_all(fd, body, len);
  close(fd);
  fprintf(stderr, "[runner] saved %zu bytes → %s\n", len, dst);
  return 0;
}

static void handle_client(int client) {
  static char buf[BUF_SIZE];
  ssize_t hdr_end = read_headers(client, buf, sizeof(buf));
  if (hdr_end < 0) return;

  char method[16] = {0}, path[512] = {0};
  if (sscanf(buf, "%15s %511s", method, path) != 2) {
    send_text(client, 400, "Bad Request", "text/plain", "bad request line");
    return;
  }

  if (strcmp(method, "GET") == 0 && (strcmp(path, "/") == 0 || strcmp(path, "/index.html") == 0)) {
    send_binary(client, workbook_html, workbook_html_len, "text/html; charset=utf-8");
    return;
  }
  if (strcmp(method, "GET") == 0 && strcmp(path, "/favicon.ico") == 0) {
    // Empty 204 — avoids 404 noise. Authors can override by serving
    // their own favicon from inside the workbook HTML.
    write_all(client,
      "HTTP/1.1 204 No Content\r\n"
      "Cache-Control: max-age=86400\r\n"
      "Connection: close\r\n\r\n", 64);
    return;
  }
  if (strcmp(method, "GET") == 0 && strcmp(path, "/_runner/info") == 0) {
    char info[512];
    int n = snprintf(info, sizeof(info),
      "{\"runner\":\"workbook-runner/0.1\",\"self\":\"%s\",\"payload_bytes\":%u}",
      self_path ? self_path : "", workbook_html_len);
    send_text(client, 200, "OK", "application/json", info);
    return;
  }
  if (strcmp(method, "POST") == 0 && strcmp(path, "/_runner/shutdown") == 0) {
    send_text(client, 200, "OK", "text/plain", "shutting down");
    running = 0;
    return;
  }
  if (strcmp(method, "PUT") == 0 && strcmp(path, "/save") == 0) {
    long content_length = parse_content_length(buf);
    if (content_length <= 0) { send_text(client, 411, "Length Required", "text/plain", "missing content-length"); return; }
    // Body might already be partially read along with headers
    size_t body_in_buf = (size_t)hdr_end - ((const char *)strstr(buf, "\r\n\r\n") + 4 - buf);
    char *body_start = strstr(buf, "\r\n\r\n") + 4;
    // Allocate full buffer
    char *body = (char *)malloc(content_length);
    if (!body) { send_text(client, 500, "Out of Memory", "text/plain", "alloc failed"); return; }
    memcpy(body, body_start, body_in_buf);
    size_t got = body_in_buf;
    while (got < (size_t)content_length) {
      ssize_t n = read(client, body + got, content_length - got);
      if (n <= 0) break;
      got += n;
    }
    int rc = handle_save(body, got);
    free(body);
    if (rc == 0) send_text(client, 200, "OK", "text/plain", "saved");
    else send_text(client, 500, "Internal Error", "text/plain", "save failed");
    return;
  }
  send_text(client, 404, "Not Found", "text/plain", "not found");
}

int main(int argc, char *argv[]) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, on_sigint);
  signal(SIGTERM, on_sigint);

  // Capture self path for save target. argv[0] may be relative.
  if (argc > 0) {
    static char realself[4096];
#ifdef __COSMOPOLITAN__
    if (realpath(argv[0], realself)) self_path = realself;
    else self_path = argv[0];
#else
    self_path = argv[0];
#endif
  }

  int port = 0;
  int sock = bind_random_port(&port);
  if (sock < 0) {
    fprintf(stderr, "[runner] failed to bind localhost: %s\n", strerror(errno));
    return 1;
  }
  fprintf(stderr, "[runner] listening on http://%s:%d/\n", BIND_HOST, port);

  open_browser(port);

  // Track idle time so we exit if the browser closes.
  time_t last_request = time(NULL);
  const int idle_timeout_seconds = 600;  // 10 minutes; tweakable

  while (running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(sock, &rfds);
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    int ready = select(sock + 1, &rfds, NULL, NULL, &tv);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ready == 0) {
      if (time(NULL) - last_request > idle_timeout_seconds) {
        fprintf(stderr, "[runner] idle timeout; exiting\n");
        break;
      }
      continue;
    }
    int client = accept(sock, NULL, NULL);
    if (client < 0) continue;
    handle_client(client);
    close(client);
    last_request = time(NULL);
  }

  close(sock);
  // Reap any browser-launcher children
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  return 0;
}
