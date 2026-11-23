use crate::{
    assets, db,
    production::repository::{
        list_project_assets, require_project_asset, ProductionError, ProjectAssetPage,
    },
    AppState,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, Manager, Runtime,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Rendition {
    Original,
    Thumbnail,
    Proxy,
}

impl Rendition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Thumbnail => "thumbnail",
            Self::Proxy => "proxy",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaGrant {
    pub(crate) url: String,
    pub(crate) expires_at: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum AccessError {
    #[error("ASSET_NOT_IN_PROJECT")]
    AssetNotInProject,
    #[error("MEDIA_GRANT_EXPIRED")]
    Expired,
    #[error("MEDIA_RANGE_INVALID")]
    InvalidRange,
    #[error("MEDIA_RENDITION_MISSING")]
    MissingRendition,
    #[error("MEDIA_DB: {0}")]
    Database(String),
}

#[derive(Debug, Clone)]
pub(crate) struct AuthorizedMedia {
    pub(crate) path: std::path::PathBuf,
    pub(crate) mime: String,
    pub(crate) bytes: u64,
}

pub(crate) fn serve_media_request<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let failure = |status| {
        Response::builder()
            .status(status)
            .body(Vec::new())
            .expect("valid media response")
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return failure(StatusCode::METHOD_NOT_ALLOWED);
    }
    let token = request
        .uri()
        .host()
        .unwrap_or_else(|| request.uri().path().trim_start_matches('/'));
    if token.is_empty() || token.contains('/') {
        return failure(StatusCode::NOT_FOUND);
    }
    let state = app.state::<AppState>();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let media = match authorize_grant(&state, window_label, token, None) {
        Ok(media) => media,
        Err(AccessError::InvalidRange) => return failure(StatusCode::RANGE_NOT_SATISFIABLE),
        Err(AccessError::AssetNotInProject) => return failure(StatusCode::FORBIDDEN),
        Err(AccessError::Expired) => return failure(StatusCode::FORBIDDEN),
        Err(AccessError::MissingRendition) => return failure(StatusCode::NOT_FOUND),
        Err(AccessError::Database(_)) => return failure(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let range = match range_header.as_deref() {
        Some(value) => match parse_byte_range(value, Some(media.bytes)) {
            Some(range) => Some(range),
            None => return failure(StatusCode::RANGE_NOT_SATISFIABLE),
        },
        None => None,
    };
    let range = range.or_else(|| (media.bytes > 0).then_some(0..media.bytes));
    let Some(range) = range else {
        return failure(StatusCode::RANGE_NOT_SATISFIABLE);
    };
    let length = range.end.saturating_sub(range.start);
    let mut response = Response::builder()
        .status(if request.headers().contains_key(header::RANGE) {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, media.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string());
    if request.headers().contains_key(header::RANGE) {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", range.start, range.end - 1, media.bytes),
        );
    }
    let mut bytes = Vec::new();
    if request.method() == Method::GET {
        let mut file = match std::fs::File::open(media.path) {
            Ok(file) => file,
            Err(_) => return failure(StatusCode::NOT_FOUND),
        };
        if file.seek(SeekFrom::Start(range.start)).is_err()
            || file.take(length).read_to_end(&mut bytes).is_err()
            || bytes.len() as u64 != length
        {
            return failure(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    response.body(bytes).expect("valid media response")
}

fn parse_byte_range(value: &str, length: Option<u64>) -> Option<Range<u64>> {
    let range = value.strip_prefix("bytes=")?;
    if range.contains(',') {
        return None;
    }
    let (start, end) = range.split_once('-')?;
    let length = length?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (length.saturating_sub(suffix), length)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            length
        } else {
            end.parse::<u64>().ok()?.checked_add(1)?.min(length)
        };
        (start, end)
    };
    (start < end && start < length).then_some(start..end)
}

pub(crate) fn open_project_media(
    state: &AppState,
    window_label: &str,
    project_id: &str,
    asset_id: &str,
    rendition: Rendition,
) -> Result<MediaGrant, AccessError> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| AccessError::Database("lock".into()))?
        .clone();
    let connection = db::open(&path).map_err(AccessError::Database)?;
    let asset =
        require_project_asset(&connection, project_id, asset_id).map_err(map_production_error)?;
    let relative = match rendition {
        Rendition::Original => asset.path.clone(),
        Rendition::Thumbnail => asset.thumb_path.clone().unwrap_or(asset.path.clone()),
        Rendition::Proxy => asset.proxy_path.clone().unwrap_or(asset.path.clone()),
    };
    let absolute =
        assets::absolute_path(&state.data_dir, &relative).map_err(AccessError::Database)?;
    if !absolute.is_file() {
        return Err(AccessError::MissingRendition);
    }
    let token = format!("mg_{}", uuid::Uuid::new_v4());
    let expires = Utc::now() + Duration::minutes(10);
    connection
        .execute(
            "DELETE FROM media_grants WHERE expires_at<=?1",
            [Utc::now().to_rfc3339()],
        )
        .map_err(|error| AccessError::Database(error.to_string()))?;
    connection.execute("INSERT INTO media_grants (token,window_label,project_id,asset_id,rendition,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", rusqlite::params![token, window_label, project_id, asset_id, rendition.as_str(), expires.to_rfc3339(), Utc::now().to_rfc3339()]).map_err(|error| AccessError::Database(error.to_string()))?;
    Ok(MediaGrant {
        url: format!("frameforge-media://{token}"),
        expires_at: expires.to_rfc3339(),
    })
}

pub(crate) fn authorize_grant(
    state: &AppState,
    window_label: &str,
    token: &str,
    range: Option<Range<u64>>,
) -> Result<AuthorizedMedia, AccessError> {
    let token = token.strip_prefix("frameforge-media://").unwrap_or(token);
    let path = state
        .db_path
        .lock()
        .map_err(|_| AccessError::Database("lock".into()))?
        .clone();
    let connection = db::open(&path).map_err(AccessError::Database)?;
    let (grant_window, project_id, asset_id, rendition, expires_at): (String, String, String, String, String) = connection.query_row("SELECT window_label,project_id,asset_id,rendition,expires_at FROM media_grants WHERE token=?1", [token], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_| AccessError::Expired)?;
    if grant_window != window_label {
        return Err(AccessError::Expired);
    }
    let expires = DateTime::parse_from_rfc3339(&expires_at)
        .map_err(|_| AccessError::Expired)?
        .with_timezone(&Utc);
    if expires <= Utc::now() {
        return Err(AccessError::Expired);
    }
    let asset =
        require_project_asset(&connection, &project_id, &asset_id).map_err(map_production_error)?;
    let relative = match rendition.as_str() {
        "original" => asset.path,
        "thumbnail" => asset.thumb_path.unwrap_or(asset.path),
        "proxy" => asset.proxy_path.unwrap_or(asset.path),
        _ => return Err(AccessError::MissingRendition),
    };
    let path = assets::absolute_path(&state.data_dir, &relative).map_err(AccessError::Database)?;
    let metadata = std::fs::metadata(&path).map_err(|_| AccessError::MissingRendition)?;
    if let Some(range) = range {
        if range.start >= range.end || range.end > metadata.len() {
            return Err(AccessError::InvalidRange);
        }
    }
    Ok(AuthorizedMedia {
        path,
        mime: asset.mime,
        bytes: metadata.len(),
    })
}

pub(crate) fn read_project_asset_text(
    state: &AppState,
    project_id: &str,
    asset_id: &str,
) -> Result<String, AccessError> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| AccessError::Database("lock".into()))?
        .clone();
    let connection = db::open(&path).map_err(AccessError::Database)?;
    let asset =
        require_project_asset(&connection, project_id, asset_id).map_err(map_production_error)?;
    std::fs::read_to_string(
        assets::absolute_path(&state.data_dir, &asset.path).map_err(AccessError::Database)?,
    )
    .map_err(|error| AccessError::Database(error.to_string()))
}

pub(crate) fn list_project_media(
    state: &AppState,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
    cursor: Option<&str>,
) -> Result<ProjectAssetPage, AccessError> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| AccessError::Database("lock".into()))?
        .clone();
    let connection = db::open(&path).map_err(AccessError::Database)?;
    list_project_assets(&connection, project_id, kind, query, cursor).map_err(map_production_error)
}

fn map_production_error(error: ProductionError) -> AccessError {
    match error {
        ProductionError::AssetNotInProject
        | ProductionError::AssetMissing
        | ProductionError::ProjectIdRequired => AccessError::AssetNotInProject,
        ProductionError::Database(message) => AccessError::Database(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        assets,
        production::repository::{record_asset_membership, AssetOrigin},
    };
    use serde_json::json;

    fn state() -> (tempfile::TempDir, AppState, String) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let asset = assets::store_bytes(
            dir.path(),
            b"hello",
            "text",
            "text/plain",
            json!({"projectId":"p1"}),
        )
        .unwrap();
        connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,payload,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", rusqlite::params![asset.id,asset.kind,asset.path,asset.mime,asset.bytes,serde_json::to_string(&asset).unwrap(),asset.created_at]).unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        record_asset_membership(
            &tx,
            "p1",
            &asset,
            &AssetOrigin {
                kind: "import".into(),
                reference: None,
            },
        )
        .unwrap();
        tx.commit().unwrap();
        (dir, state, asset.id)
    }

    #[test]
    fn denies_unowned_hash_and_expired_grant() {
        let (_dir, state, asset_id) = state();
        assert_eq!(
            open_project_media(&state, "main", "p2", &asset_id, Rendition::Original).unwrap_err(),
            AccessError::AssetNotInProject
        );
        let grant =
            open_project_media(&state, "main", "p1", &asset_id, Rendition::Original).unwrap();
        let token = grant.url.strip_prefix("frameforge-media://").unwrap();
        let path = state.db_path.lock().unwrap().clone();
        let connection = db::open(&path).unwrap();
        connection
            .execute(
                "UPDATE media_grants SET expires_at='2000-01-01T00:00:00Z' WHERE token=?1",
                [token],
            )
            .unwrap();
        assert_eq!(
            authorize_grant(&state, "main", &grant.url, None).unwrap_err(),
            AccessError::Expired
        );
    }

    #[test]
    fn range_only_reads_authorized_asset() {
        let (_dir, state, asset_id) = state();
        let grant =
            open_project_media(&state, "main", "p1", &asset_id, Rendition::Original).unwrap();
        let media = authorize_grant(&state, "main", &grant.url, Some(0..5)).unwrap();
        assert_eq!(media.bytes, 5);
        assert_eq!(media.mime, "text/plain");
        assert_eq!(
            authorize_grant(&state, "main", &grant.url, Some(0..6)).unwrap_err(),
            AccessError::InvalidRange
        );
    }

    #[test]
    fn parses_only_single_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-4", Some(10)), Some(0..5));
        assert_eq!(parse_byte_range("bytes=5-", Some(10)), Some(5..10));
        assert_eq!(parse_byte_range("bytes=-4", Some(10)), Some(6..10));
        assert_eq!(parse_byte_range("bytes=10-", Some(10)), None);
        assert_eq!(parse_byte_range("bytes=0-1,4-5", Some(10)), None);
        assert_eq!(parse_byte_range("bytes=-0", Some(10)), None);
        assert_eq!(parse_byte_range("bytes=7-3", Some(10)), None);
    }
}
