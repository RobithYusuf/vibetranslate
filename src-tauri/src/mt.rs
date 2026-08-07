// Local (offline) machine translation — NLLB-200 distilled 600M (int8, ~615 MB) via the
// mt-cli helper PROCESS (ct2/sentencepiece must not share a process with sherpa-onnx:
// duplicate protobuf symbols crashed the app). One model covers all app languages.
// Benchmark: 0.2-0.4s per sentence on CPU; quality is close to an LLM for common pairs,
// with direct id<->ja and friends (no pivoting through English).
use tauri::Manager;

/// App language code -> FLORES-200 code (every language in the app dropdown is covered).
fn flores(code: &str) -> Option<&'static str> {
    Some(match code {
        "id" => "ind_Latn",
        "en" => "eng_Latn",
        "ja" => "jpn_Jpan",
        "zh" => "zho_Hans",
        "ko" => "kor_Hang",
        "ar" => "arb_Arab",
        "es" => "spa_Latn",
        "fr" => "fra_Latn",
        "de" => "deu_Latn",
        "pt" => "por_Latn",
        "ru" => "rus_Cyrl",
        _ => return None,
    })
}

fn mt_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mt-models"))
}

/// Is the offline translator installed (helper binary + NLLB model)?
#[tauri::command]
pub async fn mt_model_status(app: tauri::AppHandle) -> Result<bool, String> {
    let root = mt_root(&app)?;
    Ok(root.join("mt-cli").exists() && root.join("nllb-600m/model.bin").exists())
}

#[derive(serde::Serialize)]
struct MtRequest<'a> {
    text: &'a str,
    model_dir: String,
    src_lang: &'static str,
    tgt_lang: &'static str,
}

/// Translate text offline via the mt-cli helper process (NLLB protocol).
#[tauri::command]
pub async fn translate_local(
    app: tauri::AppHandle,
    text: String,
    from: String,
    to: String,
) -> Result<String, String> {
    let src = flores(&from).ok_or_else(|| format!("bahasa sumber tidak didukung offline: {from}"))?;
    let tgt = flores(&to).ok_or_else(|| format!("bahasa target tidak didukung offline: {to}"))?;
    let root = mt_root(&app)?;
    let cli = root.join("mt-cli");
    let dir = root.join("nllb-600m");
    if !cli.exists() || !dir.join("model.bin").exists() {
        return Err("Model offline belum terpasang".into());
    }
    let payload = serde_json::to_string(&MtRequest {
        text: &text,
        model_dir: dir.to_string_lossy().into_owned(),
        src_lang: src,
        tgt_lang: tgt,
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(&cli)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("mt-cli spawn: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("mt-cli stdin")?
            .write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "mt-cli gagal: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
