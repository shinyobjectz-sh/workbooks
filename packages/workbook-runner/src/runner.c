// Workbook Runner — single-file polyglot workbook host with true
// self-rewrite-on-save.
//
// File layout:
//   [APE binary stub]            -- compiled C runner, fixed at build
//   [HTML payload]               -- L bytes; the workbook's HTML
//   [4-byte BE length: L]        -- trailing length so we can seek back
//
// On startup: read self, seek to end - 4, read L, then read L bytes
// preceding it = the workbook HTML payload. Serve it on GET /.
//
// On PUT /save: receive new HTML; compute stub size as
// file_size - 4 - current_L. Open a temp file in the same directory;
// write [original stub bytes] + [new HTML] + [4-byte BE length].
// fsync + rename over self. fully atomic.
//
// Crash safety: rename is atomic on POSIX/NTFS. If we crash before
// rename, the original binary is untouched. If we crash after rename,
// the new file is durable. There is no "half-written" state visible
// to subsequent runs.

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
#include <stdint.h>

#define BUF_SIZE (8 * 1024 * 1024)
#define BIND_HOST "127.0.0.1"
#define LEN_FOOTER_SIZE 4   // 4-byte big-endian payload length at end of file

static volatile sig_atomic_t running = 1;
static char self_path[4096] = {0};

// In-memory copy of the current workbook HTML, populated at startup
// from the binary's appended payload. Reads serve from here; writes
// update here AND atomically rewrite the file on disk.
static char *current_html = NULL;
static size_t current_html_len = 0;

static void on_sigint(int signo) { (void)signo; running = 0; }

// ── Self-payload IO ──────────────────────────────────────────────

static uint32_t read_u32_be(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
         ((uint32_t)p[2] << 8)  | (uint32_t)p[3];
}
static void write_u32_be(unsigned char *p, uint32_t v) {
  p[0] = (v >> 24) & 0xff; p[1] = (v >> 16) & 0xff;
  p[2] = (v >> 8) & 0xff;  p[3] = v & 0xff;
}

// Read the workbook payload off the END of self. Returns 0 on success;
// fills *out_buf (malloc'd) and *out_len. Caller frees.
static int load_payload_from_self(const char *path, char **out_buf, size_t *out_len) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return -1;
  if (fseek(fp, -LEN_FOOTER_SIZE, SEEK_END) != 0) { fclose(fp); return -1; }
  unsigned char footer[LEN_FOOTER_SIZE];
  if (fread(footer, 1, LEN_FOOTER_SIZE, fp) != LEN_FOOTER_SIZE) { fclose(fp); return -1; }
  uint32_t plen = read_u32_be(footer);
  if (plen == 0 || plen > 256 * 1024 * 1024 /* 256MB sanity cap */) {
    fclose(fp); return -1;
  }
  if (fseek(fp, -(LEN_FOOTER_SIZE + (long)plen), SEEK_END) != 0) { fclose(fp); return -1; }
  char *buf = (char *)malloc(plen);
  if (!buf) { fclose(fp); return -1; }
  size_t got = fread(buf, 1, plen, fp);
  fclose(fp);
  if (got != plen) { free(buf); return -1; }
  *out_buf = buf;
  *out_len = plen;
  return 0;
}

// Atomically rewrite self with a new payload. Computes stub bytes
// from current file (file_size - 4 - current_payload_len), copies
// them, appends new HTML + new length, fsync's, renames over self.
static int rewrite_self(const char *new_html, size_t new_len) {
  // 1. Stat self to get current size and compute stub size.
  struct stat st;
  if (stat(self_path, &st) != 0) return -1;
  off_t total = st.st_size;
  off_t stub_size = total - LEN_FOOTER_SIZE - (off_t)current_html_len;
  if (stub_size <= 0 || stub_size > total) return -1;

  // 2. Open self for reading (the stub portion).
  FILE *fin = fopen(self_path, "rb");
  if (!fin) return -1;

  // 3. Open a temp file in the same directory.
  char tmp_path[4096 + 32];
  snprintf(tmp_path, sizeof(tmp_path), "%s.tmp.%d", self_path, (int)getpid());
  FILE *fout = fopen(tmp_path, "wb");
  if (!fout) { fclose(fin); return -1; }

  // 4. Copy stub bytes from self → tmp.
  static char copybuf[1024 * 1024];
  off_t left = stub_size;
  while (left > 0) {
    size_t want = (size_t)(left > (off_t)sizeof(copybuf) ? (off_t)sizeof(copybuf) : left);
    size_t got = fread(copybuf, 1, want, fin);
    if (got != want) { fclose(fin); fclose(fout); unlink(tmp_path); return -1; }
    if (fwrite(copybuf, 1, got, fout) != got) { fclose(fin); fclose(fout); unlink(tmp_path); return -1; }
    left -= (off_t)got;
  }
  fclose(fin);

  // 5. Append new payload + footer length.
  if (fwrite(new_html, 1, new_len, fout) != new_len) { fclose(fout); unlink(tmp_path); return -1; }
  unsigned char footer[LEN_FOOTER_SIZE];
  write_u32_be(footer, (uint32_t)new_len);
  if (fwrite(footer, 1, LEN_FOOTER_SIZE, fout) != LEN_FOOTER_SIZE) { fclose(fout); unlink(tmp_path); return -1; }

  // 6. fsync + close.
  fflush(fout);
  int fd = fileno(fout);
  if (fd >= 0) fsync(fd);
  fclose(fout);

  // 7. chmod tmp +x to match self (rename preserves permissions on
  // most platforms but we want to be defensive).
  chmod(tmp_path, st.st_mode);

  // 8. Atomic rename over self. On POSIX this is atomic. On Windows
  // (cosmopolitan), MoveFileEx with REPLACE_EXISTING is used.
  if (rename(tmp_path, self_path) != 0) {
    unlink(tmp_path);
    return -1;
  }

  // 9. Swap in-memory payload.
  free(current_html);
  current_html = (char *)malloc(new_len);
  if (!current_html) { current_html_len = 0; return -1; }
  memcpy(current_html, new_html, new_len);
  current_html_len = new_len;

  fprintf(stderr, "[runner] rewrote self with %zu byte payload\n", new_len);
  return 0;
}

// ── HTTP server primitives ───────────────────────────────────────

static int bind_random_port(int *out_port) {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock < 0) return -1;
  int yes = 1;
  setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  struct sockaddr_in addr = {0};
  addr.sin_family = AF_INET;
  inet_pton(AF_INET, BIND_HOST, &addr.sin_addr);
  addr.sin_port = 0;
  if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) { close(sock); return -1; }
  if (listen(sock, 8) < 0) { close(sock); return -1; }
  socklen_t addrlen = sizeof(addr);
  if (getsockname(sock, (struct sockaddr *)&addr, &addrlen) < 0) { close(sock); return -1; }
  *out_port = ntohs(addr.sin_port);
  return sock;
}

static void open_browser(int port) {
  char url[64];
  snprintf(url, sizeof(url), "http://%s:%d/", BIND_HOST, port);
  fprintf(stderr, "[runner] opening %s\n", url);
  if (getenv("WB_RUNNER_NO_BROWSER")) {
    fprintf(stderr, "[runner] WB_RUNNER_NO_BROWSER set; skipping browser launch\n");
    return;
  }
  pid_t pid = fork();
  if (pid == 0) {
    execlp("open", "open", url, NULL);
    execlp("xdg-open", "xdg-open", url, NULL);
    execlp("cmd.exe", "cmd.exe", "/c", "start", url, NULL);
    fprintf(stderr, "[runner] could not launch browser; open %s manually\n", url);
    _exit(1);
  }
}

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

static const char *ci_substr(const char *hay, const char *needle) {
  size_t nlen = strlen(needle);
  for (const char *p = hay; *p; p++) {
    if (strncasecmp(p, needle, nlen) == 0) return p;
  }
  return NULL;
}

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
    "Connection: close\r\n\r\n",
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
    "Connection: close\r\n\r\n",
    type, len);
  write_all(client, hdr, n);
  write_all(client, data, len);
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
    send_binary(client, current_html, current_html_len, "text/html; charset=utf-8");
    return;
  }
  if (strcmp(method, "GET") == 0 && strcmp(path, "/favicon.ico") == 0) {
    write_all(client,
      "HTTP/1.1 204 No Content\r\n"
      "Cache-Control: max-age=86400\r\n"
      "Connection: close\r\n\r\n", 64);
    return;
  }
  if (strcmp(method, "GET") == 0 && strcmp(path, "/_runner/info") == 0) {
    char info[512];
    int n = snprintf(info, sizeof(info),
      "{\"runner\":\"workbook-runner/0.2\",\"self\":\"%s\",\"payload_bytes\":%zu,\"self_rewrite\":true}",
      self_path, current_html_len);
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
    if (content_length > 256 * 1024 * 1024) { send_text(client, 413, "Payload Too Large", "text/plain", "256MB limit"); return; }

    const char *body_start = strstr(buf, "\r\n\r\n") + 4;
    size_t body_in_buf = (size_t)hdr_end - (body_start - buf);
    char *body = (char *)malloc(content_length);
    if (!body) { send_text(client, 500, "Out of Memory", "text/plain", "alloc failed"); return; }
    memcpy(body, body_start, body_in_buf);
    size_t got = body_in_buf;
    while (got < (size_t)content_length) {
      ssize_t n = read(client, body + got, content_length - got);
      if (n <= 0) break;
      got += n;
    }
    int rc = rewrite_self(body, got);
    free(body);
    if (rc == 0) send_text(client, 200, "OK", "text/plain", "saved");
    else send_text(client, 500, "Internal Error", "text/plain", "rewrite failed");
    return;
  }
  send_text(client, 404, "Not Found", "text/plain", "not found");
}

// ── main ─────────────────────────────────────────────────────────

int main(int argc, char *argv[]) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGINT, on_sigint);
  signal(SIGTERM, on_sigint);

  // Capture absolute self path. argv[0] is unreliable; use realpath.
  if (argc > 0) {
    if (!realpath(argv[0], self_path)) {
      strncpy(self_path, argv[0], sizeof(self_path) - 1);
    }
  }

  // Load workbook payload from end of self.
  if (load_payload_from_self(self_path, &current_html, &current_html_len) != 0) {
    fprintf(stderr, "[runner] failed to load payload from %s — was this binary built with build.sh?\n", self_path);
    return 1;
  }
  fprintf(stderr, "[runner] loaded %zu byte payload from self\n", current_html_len);

  int port = 0;
  int sock = bind_random_port(&port);
  if (sock < 0) {
    fprintf(stderr, "[runner] failed to bind localhost: %s\n", strerror(errno));
    return 1;
  }
  fprintf(stderr, "[runner] listening on http://%s:%d/\n", BIND_HOST, port);

  open_browser(port);

  time_t last_request = time(NULL);
  const int idle_timeout_seconds = 600;

  while (running) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(sock, &rfds);
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    int ready = select(sock + 1, &rfds, NULL, NULL, &tv);
    if (ready < 0) { if (errno == EINTR) continue; break; }
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
  free(current_html);
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  return 0;
}
