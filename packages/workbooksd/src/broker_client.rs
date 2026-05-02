// C1.8 — daemon-side broker auth flow.
//
// What this does:
//
//   1. Bind 127.0.0.1:0 (kernel-assigned port) — single-shot HTTP
//      listener that accepts one GET /cb?broker_code=<code> request.
//   2. Open the system browser to
//        <broker>/v1/auth/start?workbook_id=<id>&return_to=http://127.0.0.1:<port>/cb
//   3. User signs in via WorkOS-federated SSO. Broker callback runs
//      OIDC exchange, mints a session, mints a one-time broker_code,
//      302s back to our localhost listener with ?broker_code=… .
//   4. We swap the broker_code at POST /v1/auth/exchange for a bearer
//      token (the broker's session id, but delivered out-of-band so
//      the daemon — which has no cookie jar on the broker's host —
//      can authenticate).
//   5. POST /v1/workbooks/<workbook_id>/key with
//      `Authorization: Bearer <bearer>` to fetch unlocked DEKs +
//      a signed lease.
//
// All secret material is held in `secrecy` types. Cleartext bytes never
// touch disk; the bearer never leaves the daemon process.
//
// References:
//   broker: apps/workbooks-broker/src/routes/{auth,workbooks}.ts
//   format: packages/workbook-cli/src/encrypt/wrapStudio.mjs
//   spec:   vendor/workbooks/docs/SECURITY_MODEL_MULTIPARTY.md
//   bd show core-1fi.1.8

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use secrecy::{ExposeSecret, SecretSlice, SecretString};
use serde::Deserialize;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// How long to wait between opening the browser and receiving the
/// broker_code on the localhost listener. Five minutes is generous —
/// covers slow IdP MFA flows but bounds a stuck flow.
const AUTH_FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
pub enum BrokerError {
    BindFailed(String),
    Timeout,
    BadCallback(&'static str),
    BrokerErrorCode(&'static str),
    HttpError(String),
    BadResponse(String),
    Denied { reason: String },
    BadDek(String),
}

impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BindFailed(e) => write!(f, "could not bind localhost listener: {e}"),
            Self::Timeout => write!(f, "auth flow timed out"),
            Self::BadCallback(reason) => write!(f, "bad callback request: {reason}"),
            Self::BrokerErrorCode(code) => write!(f, "broker error: {code}"),
            Self::HttpError(e) => write!(f, "broker HTTP error: {e}"),
            Self::BadResponse(e) => write!(f, "broker returned unparseable response: {e}"),
            Self::Denied { reason } => write!(f, "access denied: {reason}"),
            Self::BadDek(e) => write!(f, "bad DEK from broker: {e}"),
        }
    }
}

impl std::error::Error for BrokerError {}

/// One unlocked view's DEK as released by the broker.
pub struct UnlockedKey {
    pub view_id: String,
    pub dek: SecretSlice<u8>,
}

/// Full result of a successful auth flow.
pub struct AuthSuccess {
    /// Bearer = broker session id. Send as `Authorization: Bearer <bearer>`
    /// for any further broker call. Held in SecretString so it's not
    /// printable / formatable. Stored for C1.10 (audit dashboard) and
    /// C1.9 (lease refresh) which will need to call back to the broker.
    #[allow(dead_code)]
    pub bearer: SecretString,
    /// Identity claims for audit + UI display.
    pub sub: String,
    pub email: String,
    /// Signed lease JWT (verified later when the workbook code runs).
    /// Opaque to the daemon today; passed through to clients.
    pub lease_jwt: String,
    pub lease_exp: i64,
    /// Per-view DEKs the recipient is authorized to unlock.
    pub keys: Vec<UnlockedKey>,
}

/// Run the full broker auth flow for a workbook id. Blocks (async)
/// until the user signs in, the broker releases keys, and we have a
/// concrete `AuthSuccess` — or an error / timeout.
pub async fn run_flow(
    broker_url: &str,
    workbook_id: &str,
    open_browser: impl FnOnce(&str),
) -> Result<AuthSuccess, BrokerError> {
    let broker_url = broker_url.trim_end_matches('/').to_string();

    // 1. Bind listener.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| BrokerError::BindFailed(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| BrokerError::BindFailed(e.to_string()))?
        .port();

    // 2. Build start URL.
    let return_to = format!("http://127.0.0.1:{port}/cb");
    let start_url = format!(
        "{broker_url}/v1/auth/start?workbook_id={}&return_to={}",
        urlencode(workbook_id),
        urlencode(&return_to),
    );

    // 3. Hand off to the browser.
    open_browser(&start_url);

    // 4. Wait for the one-shot callback. Bound by AUTH_FLOW_TIMEOUT
    //    so a tab the user closed doesn't pin a daemon thread forever.
    let code = tokio::time::timeout(AUTH_FLOW_TIMEOUT, accept_one_callback(listener))
        .await
        .map_err(|_| BrokerError::Timeout)??;

    // 5. Exchange broker_code → bearer.
    let exchange = exchange_code(&broker_url, &code).await?;

    // 6. Fetch keys + lease for the workbook.
    let release = release_keys(&broker_url, &exchange.bearer, workbook_id).await?;

    let keys = release
        .keys
        .into_iter()
        .map(|k| {
            let bytes = URL_SAFE_NO_PAD
                .decode(k.dek.trim_end_matches('='))
                .map_err(|e| BrokerError::BadDek(format!("base64url: {e}")))?;
            if bytes.len() != 32 {
                return Err(BrokerError::BadDek(format!("len={}", bytes.len())));
            }
            Ok(UnlockedKey {
                view_id: k.view_id,
                dek: SecretSlice::new(bytes.into_boxed_slice()),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AuthSuccess {
        bearer: SecretString::from(exchange.bearer),
        sub: exchange.sub,
        email: exchange.email,
        lease_jwt: release.lease.jwt,
        lease_exp: release.lease.claims.exp,
        keys,
    })
}

/// Accept one connection, read the request line, parse out the
/// `broker_code` query param, write a small "you can close this tab"
/// HTML response, drop the listener.
async fn accept_one_callback(listener: TcpListener) -> Result<String, BrokerError> {
    let (mut sock, _peer) = listener
        .accept()
        .await
        .map_err(|e| BrokerError::HttpError(format!("accept: {e}")))?;

    // Read up to 8KB — enough for any reasonable request line + headers.
    // We don't care about the body; this is only ever a GET.
    let mut buf = [0u8; 8192];
    let mut total = 0usize;
    loop {
        let n = sock
            .read(&mut buf[total..])
            .await
            .map_err(|e| BrokerError::HttpError(format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        total += n;
        // Stop at end of HTTP headers.
        if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if total == buf.len() {
            return Err(BrokerError::BadCallback("oversized request"));
        }
    }

    let head = std::str::from_utf8(&buf[..total])
        .map_err(|_| BrokerError::BadCallback("non-utf8 request"))?;
    let request_line = head
        .lines()
        .next()
        .ok_or(BrokerError::BadCallback("empty request"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        respond_plain(&mut sock, 405, "method not allowed").await;
        return Err(BrokerError::BadCallback("non-GET"));
    }

    // target is e.g. "/cb?broker_code=…&maybe=other"
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != "/cb" {
        respond_plain(&mut sock, 404, "not found").await;
        return Err(BrokerError::BadCallback("wrong path"));
    }

    let mut code: Option<String> = None;
    let mut err: Option<String> = None;
    for kv in query.split('&') {
        if kv.is_empty() {
            continue;
        }
        let (k, v) = match kv.split_once('=') {
            Some(p) => p,
            None => continue,
        };
        match k {
            "broker_code" => code = Some(urldecode(v)),
            "error" => err = Some(urldecode(v)),
            _ => {}
        }
    }

    if let Some(_) = err {
        respond_html(
            &mut sock,
            400,
            "<!doctype html><h1>Sign-in failed</h1><p>You can close this tab.</p>",
        )
        .await;
        return Err(BrokerError::BrokerErrorCode("workos_or_policy_error"));
    }

    let code = code.ok_or_else(|| {
        // Best-effort response so the user sees something in the browser.
        BrokerError::BadCallback("missing broker_code")
    })?;

    respond_html(
        &mut sock,
        200,
        "<!doctype html><meta charset=\"utf-8\">\
         <title>Workbooks — signed in</title>\
         <body style=\"font-family:system-ui;padding:40px;color:#333\">\
         <h1 style=\"font-weight:600\">Signed in.</h1>\
         <p>You can close this tab and return to the workbook.</p>\
         </body>",
    )
    .await;

    Ok(code)
}

async fn respond_html(sock: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Error" };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.shutdown().await;
}

async fn respond_plain(sock: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status < 400 { "OK" } else { "Error" };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.shutdown().await;
}

#[derive(Deserialize)]
struct ExchangeResponse {
    bearer: String,
    sub: String,
    email: String,
    #[allow(dead_code)]
    expires_at: i64,
}

async fn exchange_code(broker_url: &str, code: &str) -> Result<ExchangeResponse, BrokerError> {
    let res = http_client()
        .post(format!("{broker_url}/v1/auth/exchange"))
        .json(&serde_json::json!({ "broker_code": code }))
        .send()
        .await
        .map_err(|e| BrokerError::HttpError(format!("exchange POST: {e}")))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(BrokerError::HttpError(format!(
            "exchange {status}: {body}"
        )));
    }
    res.json::<ExchangeResponse>()
        .await
        .map_err(|e| BrokerError::BadResponse(format!("exchange: {e}")))
}

#[derive(Deserialize)]
struct LeaseClaims {
    exp: i64,
    #[serde(default)]
    #[allow(dead_code)]
    iat: i64,
    #[serde(default)]
    #[allow(dead_code)]
    jti: String,
}

#[derive(Deserialize)]
struct SignedLease {
    jwt: String,
    claims: LeaseClaims,
}

#[derive(Deserialize)]
struct ReleasedKey {
    view_id: String,
    dek: String,
}

#[derive(Deserialize)]
struct ReleaseResponse {
    lease: SignedLease,
    keys: Vec<ReleasedKey>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
    #[serde(default)]
    reason: Option<String>,
}

async fn release_keys(
    broker_url: &str,
    bearer: &str,
    workbook_id: &str,
) -> Result<ReleaseResponse, BrokerError> {
    let res = http_client()
        .post(format!(
            "{broker_url}/v1/workbooks/{}/key",
            urlencode(workbook_id)
        ))
        .header("Authorization", format!("Bearer {bearer}"))
        // Empty JSON body — POST shape is forward-compatible with C2's
        // transport_pubkey (per workbooks.ts comment).
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| BrokerError::HttpError(format!("key POST: {e}")))?;

    let status = res.status();
    if status.is_success() {
        return res
            .json::<ReleaseResponse>()
            .await
            .map_err(|e| BrokerError::BadResponse(format!("key release: {e}")));
    }

    // Surface 403 / 410 with the broker's structured reason. Anything
    // else is bubbled as a generic HTTP error.
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::GONE {
        let body = res.json::<ErrorBody>().await.unwrap_or(ErrorBody {
            error: "denied".into(),
            reason: None,
        });
        return Err(BrokerError::Denied {
            reason: body
                .reason
                .unwrap_or_else(|| body.error.clone()),
        });
    }
    let body = res.text().await.unwrap_or_default();
    Err(BrokerError::HttpError(format!("key release {status}: {body}")))
}

fn http_client() -> reqwest::Client {
    // The daemon already pulls reqwest with rustls-tls in Cargo.toml.
    // Build a fresh client per flow — flows are rare enough that
    // amortizing a connection pool isn't worth the global state.
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

/// Minimal application/x-www-form-urlencoded percent encoder for query
/// param values. Encodes anything outside the unreserved set per
/// RFC 3986 §2.3.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b;
        let unreserved = c.is_ascii_alphanumeric()
            || c == b'-'
            || c == b'_'
            || c == b'.'
            || c == b'~';
        if unreserved {
            out.push(c as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", c));
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

// Expose the bearer through the SecretString safety net only when
// it actually needs to leave the broker_client (e.g., to call further
// broker endpoints from elsewhere). Daemon code outside this module
// generally does not need to touch the bearer directly — it caches
// keys on the session and is done.
impl AuthSuccess {
    #[allow(dead_code)]
    pub fn bearer(&self) -> &str {
        self.bearer.expose_secret()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_basics() {
        assert_eq!(urlencode("hello world"), "hello%20world");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("alice@example.com"), "alice%40example.com");
        assert_eq!(urlencode("plain-_.~123"), "plain-_.~123");
    }

    #[test]
    fn urldecode_basics() {
        assert_eq!(urldecode("hello%20world"), "hello world");
        assert_eq!(urldecode("a%26b%3Dc"), "a&b=c");
        assert_eq!(urldecode("alice%40example.com"), "alice@example.com");
        assert_eq!(urldecode("plain"), "plain");
    }

    #[test]
    fn urlencode_decode_roundtrip() {
        for s in [
            "wb_fixture_abc",
            "alice@example.com",
            "https://broker.example/x?y=z",
            "spaces and stuff",
        ] {
            assert_eq!(urldecode(&urlencode(s)), s);
        }
    }
}
