use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum PublishError {
    #[error("EXPORT_TARGET_CONFLICT")]
    TargetConflict,
    #[error("EXPORT_PUBLISH_FAILED")]
    Failed(String),
}

pub(crate) fn publish_once(staged: &Path, target: &Path) -> Result<PathBuf, PublishError> {
    publish_with_link(staged, target, &|source, destination| fs::hard_link(source, destination))
}

/// 发布到目标：先把内容复制到目标同目录的独占临时文件，再落到目标名。
/// `link` 是落盘动作，跨文件系统（不支持硬链接的 U 盘、网盘）会失败，
/// 此时回退到同目录 rename。
fn publish_with_link(
    staged: &Path,
    target: &Path,
    link: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf, PublishError> {
    if target.exists() {
        return Err(PublishError::TargetConflict);
    }
    let parent = target
        .parent()
        .ok_or_else(|| PublishError::Failed("target parent missing".into()))?;
    fs::create_dir_all(parent).map_err(|e| PublishError::Failed(e.to_string()))?;
    let temporary = parent.join(format!(".frameforge-publish-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut source = fs::File::open(staged).map_err(|e| PublishError::Failed(e.to_string()))?;
        let mut destination = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|e| PublishError::Failed(e.to_string()))?;
        std::io::copy(&mut source, &mut destination).map_err(|e| PublishError::Failed(e.to_string()))?;
        destination.flush().map_err(|e| PublishError::Failed(e.to_string()))?;
        destination.sync_all().map_err(|e| PublishError::Failed(e.to_string()))?;
        drop(destination);
        match link(&temporary, target) {
            Ok(()) => {
                let _ = fs::remove_file(&temporary);
            }
            Err(error) if is_cross_device_or_unsupported(&error) => {
                if target.exists() {
                    return Err(PublishError::TargetConflict);
                }
                fs::rename(&temporary, target).map_err(|e| PublishError::Failed(e.to_string()))?;
            }
            Err(error) => {
                return Err(if target.exists() { PublishError::TargetConflict } else { PublishError::Failed(error.to_string()) });
            }
        }
        fs::remove_file(staged).map_err(|e| PublishError::Failed(e.to_string()))?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result?;
    Ok(target.to_path_buf())
}

/// 跨设备（EXDEV）或文件系统不支持硬链接（exFAT/FAT32、SMB 等）的错误。
fn is_cross_device_or_unsupported(error: &std::io::Error) -> bool {
    match error.raw_os_error() {
        Some(code) => matches!(code, 1 | 18 | 38 | 95 | 97),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_through_a_hard_link_when_the_filesystem_supports_it() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.mp4");
        let target = directory.path().join("out.mp4");
        std::fs::write(&staged, b"payload").unwrap();
        let published = publish_once(&staged, &target).unwrap();
        assert_eq!(published, target);
        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        assert!(!staged.exists(), "发布后暂存文件应被清掉");
    }

    #[test]
    fn falls_back_to_rename_when_hard_link_is_unsupported() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.mp4");
        let target = directory.path().join("out.mp4");
        std::fs::write(&staged, b"payload").unwrap();
        let published = publish_with_link(&staged, &target, &|_, _| {
            Err(std::io::Error::from_raw_os_error(18))
        })
        .unwrap();
        assert_eq!(published, target);
        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        assert!(!staged.exists());
    }

    #[test]
    fn fallback_still_refuses_to_overwrite_an_existing_target() {
        let directory = tempfile::tempdir().unwrap();
        let staged = directory.path().join("staged.mp4");
        let target = directory.path().join("out.mp4");
        std::fs::write(&staged, b"payload").unwrap();
        std::fs::write(&target, b"old").unwrap();
        let error = publish_with_link(&staged, &target, &|_, _| {
            Err(std::io::Error::from_raw_os_error(18))
        })
        .unwrap_err();
        assert_eq!(error, PublishError::TargetConflict);
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
    }
}
