//! The rule every outbound request URL has to clear.
//!
//! Two callers need it and neither is the other: the AI endpoint carries an API
//! key, and a book source is a third-party JSON definition the reader imported
//! by pasting a URL. Both send a request on the reader's behalf to an address
//! somebody else chose, so neither may put it in clear text across a network
//! the reader does not control.
//!
//! `http://` on loopback stays usable — that is how Ollama, LM Studio and a
//! reader's own machine are reached, and it is the reader's own traffic either
//! way. Everything else has to be `https://`.
//!
//! One function rather than one copy per caller: two copies of a security rule
//! is how the second one quietly stops being applied when a new call site is
//! added.

use crate::error::{AppError, AppResult};

/// Trims whitespace and trailing slashes — so a later path join cannot produce
/// `//v1` — and refuses any scheme that would leave the request in clear text.
///
/// `label` names the setting in the message, because "接口地址必须是 https"
/// is wrong advice on a screen that is editing a book source.
pub fn secure_base_url(raw: &str, label: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument(format!("{label}不能为空")));
    }
    let is_loopback_http = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");
    if !trimmed.starts_with("https://") && !is_loopback_http {
        return Err(AppError::InvalidArgument(format!(
            "{label}必须是 https，本地可用 http://localhost"
        )));
    }
    Ok(trimmed.to_string())
}

/// The hosts one outbound caller may reach.
///
/// `secure_base_url` answers "is this address safe to put on the wire". This
/// answers the other question: "did the party we handed the request to choose
/// this address". A book source is a third-party JSON definition — its
/// `baseUrl` is an address its author picked, but the *data* the site returns
/// can name any URL, and that URL is then fetched with the reader's IP and
/// their proxy settings. Only the base host, plus the hosts the definition
/// declares in `permissions.hosts`, may be reached, and the same rule holds
/// for every redirect hop.
#[derive(Debug, Clone)]
pub struct Hosts {
    allowed: Vec<String>,
}

impl Hosts {
    pub fn new(base_url: &str, declared: &[String]) -> AppResult<Self> {
        let base = host_of(&secure_base_url(base_url, "书源地址")?)
            .ok_or_else(|| AppError::InvalidArgument("书源地址里没有主机名".into()))?;
        let mut allowed = vec![base];
        for host in declared {
            let host = host.trim().to_ascii_lowercase();
            if !is_bare_host(&host) {
                return Err(AppError::InvalidArgument(format!(
                    "权限里的主机名不合法：{host}（只写主机名，不能带 https://、路径或通配符）"
                )));
            }
            allowed.push(strip_default_port(&host));
        }
        Ok(Self { allowed })
    }

    /// Clears one URL and hands it back ready to request.
    pub fn check(&self, url: &str) -> AppResult<String> {
        let url = secure_base_url(url, "书源请求地址")?;
        let host = host_of(&url)
            .ok_or_else(|| AppError::InvalidArgument(format!("书源请求地址没有主机名：{url}")))?;
        if self.allowed.contains(&host) {
            return Ok(url);
        }
        Err(AppError::InvalidArgument(format!(
            "这个书源不许访问 {host}：如果确实需要，把它加进书源的 permissions.hosts"
        )))
    }

    /// A redirect to a host outside the set is a request somebody else chose,
    /// so it stops at that hop instead of quietly succeeding.
    pub fn redirect_policy(&self) -> reqwest::redirect::Policy {
        let hosts = self.clone();
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 {
                return attempt.error("书源重定向次数过多");
            }
            match hosts.check(attempt.url().as_str()) {
                Ok(_) => attempt.follow(),
                Err(err) => attempt.error(err.to_string()),
            }
        })
    }
}

/// `https://user@Host.Example:443/a?b` → `host.example`.
fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    if authority.is_empty() {
        return None;
    }
    Some(strip_default_port(&authority.to_ascii_lowercase()))
}

fn strip_default_port(host: &str) -> String {
    host.strip_suffix(":443").or_else(|| host.strip_suffix(":80")).unwrap_or(host).to_string()
}

/// A declared permission is a host, not a URL and not a pattern: `*` would
/// make the allowlist say yes to everything, which is the state this replaces.
fn is_bare_host(host: &str) -> bool {
    if host.is_empty()
        || host.contains(['/', '?', '#', '*', '@'])
        || host.chars().any(char::is_whitespace)
    {
        return false;
    }
    match host.rsplit_once(':') {
        Some((name, port)) => {
            !name.is_empty() && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
        }
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_text_http_is_only_allowed_on_loopback() {
        assert!(secure_base_url("http://localhost:11434/v1", "接口地址").is_ok());
        assert!(secure_base_url("http://127.0.0.1:1234/v1", "接口地址").is_ok());
        assert!(secure_base_url("http://[::1]:1234/v1", "接口地址").is_ok());
        // The key travels in clear text, and so does every query the reader
        // types into a search box.
        assert!(secure_base_url("http://example.com/v1", "接口地址").is_err(), "外网必须走 https");
        assert!(secure_base_url("http://192.168.1.10/api", "接口地址").is_err(), "局域网也算外网");
        assert!(secure_base_url("ftp://x", "接口地址").is_err());
        assert!(secure_base_url("   ", "接口地址").is_err());
    }

    #[test]
    fn the_result_is_ready_to_join_a_path_onto() {
        assert_eq!(
            secure_base_url("  https://api.example.com/v1/  ", "接口地址").expect("https"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn the_message_names_the_setting_it_was_asked_about() {
        let err = secure_base_url("http://example.com", "书源地址").expect_err("must be rejected");
        assert!(err.to_string().contains("书源地址"), "{err}");
    }

    fn hosts(declared: &[&str]) -> Hosts {
        let declared: Vec<String> = declared.iter().map(|host| (*host).to_string()).collect();
        Hosts::new("https://example.com/api", &declared).expect("allowlist")
    }

    #[test]
    fn the_base_host_is_always_allowed() {
        assert!(hosts(&[]).check("https://example.com/other/x.json").is_ok());
        // Case and the default port are not a different host.
        assert!(hosts(&[]).check("https://Example.COM:443/x").is_ok());
    }

    #[test]
    fn a_host_nobody_granted_is_refused_by_name() {
        let err = hosts(&[]).check("https://cdn.example.net/ch1").expect_err("refused");
        let text = err.to_string();
        assert!(text.contains("cdn.example.net"), "{text}");
        assert!(text.contains("permissions.hosts"), "错误要说清怎么放行：{text}");
    }

    #[test]
    fn a_declared_host_is_usable() {
        assert!(hosts(&["CDN.Example.net"]).check("https://cdn.example.net/ch1").is_ok());
    }

    #[test]
    fn a_url_from_the_data_still_has_to_be_https() {
        // The old path let any absolute URL through untouched, so a source
        // could have its response point at a plain-text hop.
        let err = hosts(&[]).check("http://example.com/x").expect_err("clear text");
        assert!(err.to_string().contains("https"), "{err}");
        let local = Hosts::new("http://localhost:8080/api", &[]).expect("loopback base");
        assert!(local.check("http://localhost:8080/x").is_ok(), "本机仍然可用");
    }

    #[test]
    fn declared_permissions_are_hosts_not_patterns() {
        for bad in ["*", "https://cdn.example.net", "cdn.example.net/x", "a b", "cdn.*.net"] {
            let err =
                Hosts::new("https://example.com", &[bad.to_string()]).expect_err("must be refused");
            assert!(err.to_string().contains("主机名不合法"), "{bad}: {err}");
        }
        assert!(Hosts::new("https://example.com:8443", &["cdn.example.net:8443".into()]).is_ok());
    }
}
