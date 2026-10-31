use crate::gateway::AppError;

pub fn validate_remote_url(value: &str) -> Result<reqwest::Url, AppError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| AppError::new("PARAM_URL_INVALID", "远端 URL 格式无效", false))?;
    if url.scheme() != "https" {
        return Err(AppError::new("PARAM_URL_INSECURE", "只允许 https 远端地址", false));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Err(AppError::new("PARAM_URL_PRIVATE", "禁止访问 localhost", false));
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let private = match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
            }
            std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
        };
        if private {
            return Err(AppError::new("PARAM_URL_PRIVATE", "禁止访问私网地址", false));
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_local_targets() {
        assert!(validate_remote_url("http://127.0.0.1/a").is_err());
        assert!(validate_remote_url("http://localhost/a").is_err());
        assert!(validate_remote_url("http://192.168.1.2/a").is_err());
        assert!(validate_remote_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn accepts_public_https() {
        assert!(validate_remote_url("https://cdn.example.com/a.png").is_ok());
    }
}
