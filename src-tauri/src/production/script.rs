use quick_xml::{events::Event, Reader};
use std::io::{Cursor, Read};

pub(crate) fn validate_script_bytes(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    if bytes.len() > max_bytes {
        return Err("SCRIPT_TOO_LARGE".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "SCRIPT_NOT_UTF8".into())
}

pub(crate) fn extract_docx_text(bytes: &[u8], max_bytes: usize) -> Result<String, String> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|_| "SCRIPT_DOCX_INVALID".to_string())?;
    if archive.len() > 128 {
        return Err("SCRIPT_DOCX_TOO_MANY_ENTRIES".into());
    }
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| "SCRIPT_DOCX_DOCUMENT_MISSING".to_string())?;
    if document.size() > max_bytes.saturating_mul(8) as u64 {
        return Err("SCRIPT_DOCX_TOO_LARGE".into());
    }
    let mut xml = Vec::new();
    document.read_to_end(&mut xml).map_err(|_| "SCRIPT_DOCX_READ_FAILED".to_string())?;
    if xml.len() > max_bytes.saturating_mul(8) {
        return Err("SCRIPT_DOCX_TOO_LARGE".into());
    }
    let mut parser = Reader::from_reader(xml.as_slice());
    parser.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut text = String::new();
    loop {
        match parser.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.name().as_ref() == b"w:tab" => text.push('\t'),
            Ok(Event::Empty(event)) if event.name().as_ref() == b"w:br" || event.name().as_ref() == b"w:cr" => text.push('\n'),
            Ok(Event::Text(event)) => {
                let value = event.unescape().map_err(|_| "SCRIPT_DOCX_XML_INVALID".to_string())?;
                text.push_str(&value);
                if text.len() > max_bytes { return Err("SCRIPT_TOO_LARGE".into()); }
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"w:p" => text.push('\n'),
            Ok(Event::Eof) => break,
            Err(_) => return Err("SCRIPT_DOCX_XML_INVALID".into()),
            _ => {}
        }
        buffer.clear();
    }
    Ok(text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_or_oversize_script() {
        assert_eq!(validate_script_bytes(&[0xff], 100).unwrap_err(), "SCRIPT_NOT_UTF8");
        assert_eq!(validate_script_bytes(&[1, 2], 1).unwrap_err(), "SCRIPT_TOO_LARGE");
    }

    #[test]
    fn docx_parser_reads_only_document_body() {
        let mut bytes = Vec::new();
        let cursor = Cursor::new(&mut bytes);
        let mut writer = zip::ZipWriter::new(cursor);
        writer.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut writer, "<w:document><w:body><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:body></w:document>".as_bytes()).unwrap();
        let _ = writer.finish().unwrap();
        assert_eq!(extract_docx_text(&bytes, 100).unwrap(), "你好");
    }
}
