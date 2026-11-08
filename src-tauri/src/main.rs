// JitDub — оболочка Tauri. Весь интерфейс и аудио-движок в ui/ (WebAudio); ядро даёт то, чего нет в WebView:
// системные диалоги сохранения/выбора папки, запись файлов на диск, открытие ссылок в браузере.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};

/// Диалог «Сохранить как». filters: [["WAV", "wav"], …]
#[tauri::command]
async fn pick_save_path(name: String, filters: Vec<(String, String)>) -> Option<String> {
    let mut dlg = rfd::AsyncFileDialog::new().set_file_name(&name);
    for (label, ext) in &filters {
        dlg = dlg.add_filter(label, &[ext.as_str()]);
    }
    dlg.save_file().await.map(|f| f.path().to_string_lossy().into_owned())
}

/// Диалог выбора папки (экспорт дорожек по отдельности).
#[tauri::command]
async fn pick_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

/// Запись бинарного файла: тело запроса — сырые байты, путь — в заголовке x-path (URI-кодированный).
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("нет заголовка x-path")?;
    let path = PathBuf::from(decode_uri(raw));
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("ожидались сырые байты".into());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("разрешены только http(s)-ссылки".into());
    }
    open::that_detached(url).map_err(|e| e.to_string())
}

/// Открыть папку с файлом в проводнике.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    let dir = if p.is_dir() { p } else { p.parent().map(|d| d.to_path_buf()).unwrap_or(p) };
    open::that_detached(dir).map_err(|e| e.to_string())
}

fn decode_uri(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- локальное видео ----------
// Видео не загружается на сервер: окно получает его по протоколу jdmedia:// прямо с диска (с поддержкой Range,
// чтобы перемотка по большим файлам была мгновенной). Путь запоминается в проекте и при следующем запуске
// видео открывается само.

const MEDIA_EXT: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "avi", "ogv", "mp3", "wav", "ogg", "m4a", "flac"];

#[derive(serde::Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
}

fn file_info_of(path: &std::path::Path) -> Option<FileInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        size: meta.len(),
    })
}

#[tauri::command]
async fn pick_video() -> Option<FileInfo> {
    let f = rfd::AsyncFileDialog::new()
        .add_filter("Видео", &["mp4", "m4v", "webm", "mkv", "mov", "avi"])
        .add_filter("Все файлы", &["*"])
        .pick_file()
        .await?;
    file_info_of(f.path())
}

/// Есть ли файл на месте (и какого он размера) — для автоматического открытия видео проекта.
#[tauri::command]
fn file_info(path: String) -> Option<FileInfo> {
    file_info_of(std::path::Path::new(&path))
}

fn media_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ogv") => "video/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn serve_media(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{header, Response, StatusCode};
    let fail = |code: StatusCode| Response::builder().status(code).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();

    let path = std::path::PathBuf::from(decode_uri(request.uri().path().trim_start_matches('/')));
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !ext_ok {
        return fail(StatusCode::FORBIDDEN);
    }
    let Ok(mut file) = std::fs::File::open(&path) else { return fail(StatusCode::NOT_FOUND) };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return fail(StatusCode::NOT_FOUND) };

    // Range: bytes=a-b (открытый конец отдаём кусками по 4 МБ — плеер дозапросит)
    const CHUNK: u64 = 4 * 1024 * 1024;
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| {
            let (a, b) = v.split_once('-')?;
            let a: u64 = if a.is_empty() { len.saturating_sub(b.parse().ok()?) } else { a.parse().ok()? };
            let b: u64 = if b.is_empty() || v.starts_with('-') { (a + CHUNK - 1).min(len - 1) } else { b.parse::<u64>().ok()?.min(len - 1) };
            (a <= b && a < len).then_some((a, b))
        });
    let (start, end, status) = match range {
        Some((a, b)) => (a, b, StatusCode::PARTIAL_CONTENT),
        None if request.headers().contains_key(header::RANGE) => return fail(StatusCode::RANGE_NOT_SATISFIABLE),
        None => (0, (CHUNK - 1).min(len.saturating_sub(1)), if len <= CHUNK { StatusCode::OK } else { StatusCode::PARTIAL_CONTENT }),
    };
    let mut buf = vec![0u8; (end - start + 1) as usize];
    if len > 0 && (file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err()) {
        return fail(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, media_mime(&path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        // нужно, чтобы звук видео можно было пустить через WebAudio (приглушение под озвучкой)
        .header("Access-Control-Allow-Origin", "*");
    if status == StatusCode::PARTIAL_CONTENT {
        res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    res.body(buf).unwrap()
}

// ---------- скачивание видео проекта с сервера ----------
// Файл качается в «Видео\JitDub\<проект>\<имя>» потоком (с докачкой из .part после обрыва),
// прогресс уходит в окно событием "jitdub-download".

static CANCELLED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[derive(Clone, serde::Serialize)]
struct DownloadEvent {
    dest: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

fn safe_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = cleaned.trim().trim_end_matches('.').to_string();
    if t.is_empty() { "video".into() } else { t.chars().take(120).collect() }
}

/// Куда будет скачано видео проекта (чтобы проверить, нет ли его уже на диске).
#[tauri::command]
fn media_dest(app: tauri::AppHandle, folder: String, name: String) -> Result<String, String> {
    use tauri::Manager;
    let base = app.path().video_dir().or_else(|_| app.path().download_dir()).map_err(|e| e.to_string())?;
    Ok(base.join("JitDub").join(safe_name(&folder)).join(safe_name(&name)).to_string_lossy().into_owned())
}

#[tauri::command]
fn download_media(app: tauri::AppHandle, url: String, token: String, dest: String) -> Result<(), String> {
    use std::io::{Read, Write};
    use tauri::Emitter;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("разрешены только http(s)-адреса".into());
    }
    CANCELLED.lock().unwrap().retain(|d| d != &dest);
    std::thread::spawn(move || {
        let emit = |received: u64, total: u64, done: bool, error: Option<String>| {
            let _ = app.emit("jitdub-download", DownloadEvent { dest: dest.clone(), received, total, done, error });
        };
        let run = || -> Result<(), String> {
            let path = std::path::PathBuf::from(&dest);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let part = path.with_extension(format!("{}.part", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
            let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let mut req = ureq::get(&url).set("Authorization", &format!("Bearer {token}"));
            if have > 0 {
                req = req.set("Range", &format!("bytes={have}-"));
            }
            let res = req.call().map_err(|e| format!("сервер: {e}"))?;
            let resumed = res.status() == 206;
            let len: u64 = res.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
            let total = if resumed { have + len } else { len };
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(resumed)
                .truncate(!resumed)
                .open(&part)
                .map_err(|e| e.to_string())?;
            let mut received = if resumed { have } else { 0 };
            let mut reader = res.into_reader();
            let mut buf = vec![0u8; 1 << 20];
            let mut last = std::time::Instant::now();
            loop {
                if CANCELLED.lock().unwrap().contains(&dest) {
                    return Err("отменено".into());
                }
                let n = reader.read(&mut buf).map_err(|e| format!("обрыв связи: {e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                received += n as u64;
                if last.elapsed().as_millis() > 200 {
                    emit(received, total, false, None);
                    last = std::time::Instant::now();
                }
            }
            file.flush().map_err(|e| e.to_string())?;
            drop(file);
            if total > 0 && received != total {
                return Err(format!("скачано {received} из {total} байт — повторите, докачается"));
            }
            std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
            emit(received, total, true, None);
            Ok(())
        };
        if let Err(e) = run() {
            emit(0, 0, true, Some(e));
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(dest: String) {
    CANCELLED.lock().unwrap().push(dest);
}

fn main() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("jdmedia", |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(serve_media(request)));
        })
        .invoke_handler(tauri::generate_handler![pick_save_path, pick_folder, write_file, open_external, reveal, pick_video, file_info, media_dest, download_media, cancel_download])
        .run(tauri::generate_context!())
        .expect("не удалось запустить JitDub");
}
