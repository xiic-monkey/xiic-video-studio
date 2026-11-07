use super::AppError;
use crate::assets;
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

/// 素材外链配置的 IPC 载荷版本。存量库里没有该字段时按 1 读取。
fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetHostConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub strategy: String,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub prefix: Option<String>,
    pub public_base_url: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
}

impl Default for AssetHostConfig {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            strategy: String::new(),
            endpoint: None,
            bucket: None,
            region: None,
            prefix: None,
            public_base_url: None,
            access_key: None,
            secret_key: None,
        }
    }
}

impl AssetHostConfig {
    fn s3_ready(&self) -> bool {
        self.endpoint.is_some()
            && self.bucket.is_some()
            && self.public_base_url.is_some()
            && self.access_key.is_some()
            && self.secret_key.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportRef {
    pub kind: String,
    pub value: String,
    pub expires_at: Option<String>,
}

pub async fn prepare_input(
    root: &Path,
    asset: &assets::AssetRef,
    allowed: &[String],
    host: &AssetHostConfig,
) -> Result<TransportRef, AppError> {
    let path = assets::absolute_path(root, &asset.path)
        .map_err(|_| AppError::new("STORAGE_PATH_INVALID", "资产路径无效", false))?;
    let bytes = std::fs::read(&path).map_err(|error| {
        AppError::new("STORAGE_READ_FAILED", format!("读取资产失败：{error}"), false)
    })?;
    prepare_bytes(root, &bytes, &asset.mime, &asset.id, allowed, host).await
}

pub async fn prepare_bytes(
    _root: &Path,
    bytes: &[u8],
    mime: &str,
    id: &str,
    allowed: &[String],
    host: &AssetHostConfig,
) -> Result<TransportRef, AppError> {
    let allows_data = allowed.iter().any(|item| item == "dataUrl");
    let allows_public = allowed.iter().any(|item| item == "publicUrl" || item == "upload");
    if allows_data && (host.strategy != "s3" || !host.s3_ready()) {
        return Ok(data_url(mime, bytes));
    }
    if allows_public && host.s3_ready() {
        return s3_put(host, bytes, mime, id).await;
    }
    if allows_data {
        return Ok(data_url(mime, bytes));
    }
    Err(AppError::new(
        "CAP_PUBLIC_URL_REQUIRED",
        "该模型要求公网可访问的输入地址，请在设置中配置 S3 兼容资产桶",
        false,
    ))
}

fn data_url(mime: &str, bytes: &[u8]) -> TransportRef {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    TransportRef {
        kind: "dataUrl".to_string(),
        value: format!("data:{mime};base64,{encoded}"),
        expires_at: None,
    }
}

/// mime 前缀即资产类别，未知 mime（如 application/octet-stream）落到 "bin"。
fn kind_for_mime(mime: &str) -> &str {
    mime.split('/').next().unwrap_or("bin")
}

async fn s3_put(
    host: &AssetHostConfig,
    bytes: &[u8],
    mime: &str,
    id: &str,
) -> Result<TransportRef, AppError> {
    let endpoint = reqwest::Url::parse(host.endpoint.as_deref().unwrap_or_default())
        .map_err(|_| AppError::new("PARAM_ASSET_HOST_INVALID", "资产桶 endpoint 无效", false))?;
    let bucket = host.bucket.as_deref().unwrap_or_default();
    let region = host.region.as_deref().unwrap_or("auto");
    let prefix = host.prefix.as_deref().unwrap_or("").trim_matches('/');
    let extension = assets::extension_for(mime, kind_for_mime(mime));
    let key = if prefix.is_empty() {
        format!("{id}.{extension}")
    } else {
        format!("{prefix}/{id}.{extension}")
    };
    let canonical_uri = format!("/{bucket}/{key}");
    let host_name = match endpoint.port() {
        Some(port) => format!("{}:{port}", endpoint.host_str().unwrap_or_default()),
        None => endpoint.host_str().unwrap_or_default().to_string(),
    };
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(bytes));
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), mime.to_string());
    headers.insert("host".to_string(), host_name);
    headers.insert("x-amz-content-sha256".to_string(), payload_hash.clone());
    headers.insert("x-amz-date".to_string(), amz_date.clone());
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let canonical_request =
        format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let signature = sign_v4(
        host.secret_key.as_deref().unwrap_or_default(),
        &amz_date,
        &date_stamp,
        region,
        "s3",
        &canonical_request,
    );
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}/{}/s3/aws4_request, SignedHeaders={}, Signature={}",
        host.access_key.as_deref().unwrap_or_default(),
        date_stamp,
        region,
        signed_headers,
        signature
    );
    let url = format!("{}{}", endpoint.as_str().trim_end_matches('/'), canonical_uri);
    let client = crate::http_client()
        .map_err(|error| AppError::new("STORAGE_UPLOAD_FAILED", error, true))?;
    let response = client
        .put(url)
        .header("authorization", authorization)
        .header("content-type", mime)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|error| {
            AppError::new("STORAGE_UPLOAD_FAILED", format!("上传资产桶失败：{error}"), true)
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let error = super::map_http_status(status, &text, "资产桶上传");
        // 存储桶的错误体同样可能回显签名用的密钥，出网关前按值脱敏。
        return Err(super::redact_secrets(error, &[
            host.access_key.as_deref().unwrap_or_default(),
            host.secret_key.as_deref().unwrap_or_default(),
        ]));
    }
    let public = format!(
        "{}/{}",
        host.public_base_url.as_deref().unwrap_or_default().trim_end_matches('/'),
        key
    );
    Ok(TransportRef {
        kind: "url".to_string(),
        value: public,
        expires_at: None,
    })
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub fn sign_v4(
    secret: &str,
    amz_date: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
    canonical_request: &str,
) -> String {
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{date_stamp}/{region}/{service}/aws4_request\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    hex::encode(hmac(&k_signing, string_to_sign.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aws_sigv4_documented_get_vector_matches() {
        let canonical = "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let signature = sign_v4(
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "20130524T000000Z",
            "20130524",
            "us-east-1",
            "s3",
            canonical,
        );
        assert_eq!(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[tokio::test]
    async fn data_url_fallback_is_used_when_transport_allows_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = b"frame";
        let host = AssetHostConfig::default();
        let result = prepare_bytes(dir.path(), bytes, "image/png", "abc123", &["dataUrl".to_string()], &host)
            .await
            .expect("data url");
        assert_eq!(result.kind, "dataUrl");
        assert!(result.value.starts_with("data:image/png;base64,"));
    }

    #[tokio::test]
    async fn public_url_only_without_s3_config_is_actionable_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = AssetHostConfig::default();
        let error = prepare_bytes(dir.path(), b"x", "image/png", "abc123", &["publicUrl".to_string()], &host)
            .await
            .expect_err("needs s3");
        assert_eq!(error.code, "CAP_PUBLIC_URL_REQUIRED");
    }

    #[test]
    fn asset_host_config_defaults_to_schema_version_one() {
        assert_eq!(AssetHostConfig::default().schema_version, 1);
    }

    #[test]
    fn asset_host_config_reads_legacy_payload_without_schema_version() {
        let legacy = r#"{"strategy":"s3","endpoint":"https://s3.example.com","publicBaseUrl":"https://cdn.example.com"}"#;
        let config: AssetHostConfig = serde_json::from_str(legacy).expect("legacy payload");
        assert_eq!(config.schema_version, 1);
        assert_eq!(config.strategy, "s3");
        assert_eq!(config.endpoint.as_deref(), Some("https://s3.example.com"));
    }
}
