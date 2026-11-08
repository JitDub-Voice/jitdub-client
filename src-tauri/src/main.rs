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
        if b[i] == b'%' && i + 2 < b.len() {
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_save_path, pick_folder, write_file, open_external, reveal])
        .run(tauri::generate_context!())
        .expect("не удалось запустить JitDub");
}
