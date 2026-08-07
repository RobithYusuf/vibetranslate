// Local (offline) speech-to-text via sherpa-onnx — the "Offline" engines in
// Settings > Voice. Curated registry: every model has a clear role, and each was
// benchmarked for Indonesian accuracy before being offered. Downloads stream from the
// models' public HuggingFace repos into
// <app-data>/speech-models/<id>/ with .part-then-rename so a killed download never
// half-installs.
use base64::Engine as _;
use sherpa_onnx::{
    OfflineModelConfig, OfflineOmnilingualAsrCtcModelConfig, OfflineRecognizer,
    OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};
use tauri::Manager;

enum ModelKind {
    /// Meta Omnilingual ASR (CTC): model.int8.onnx + tokens.txt
    OmnilingualCtc,
    /// NVIDIA NeMo transducer (Parakeet): encoder/decoder/joiner + tokens.txt
    NemoTransducer,
    /// OpenAI Whisper (turbo): encoder/decoder + tokens.txt; honors a language hint
    Whisper,
}

struct ModelSpec {
    id: &'static str,
    kind: ModelKind,
    /// (filename, url, size estimate for progress before Content-Length arrives)
    files: &'static [(&'static str, &'static str, u64)],
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "omnilingual-300m",
        kind: ModelKind::OmnilingualCtc,
        files: &[
            (
                "model.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/main/model.int8.onnx?download=true",
                365_000_000,
            ),
            (
                "tokens.txt",
                "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/main/tokens.txt?download=true",
                90_000,
            ),
        ],
    },
    ModelSpec {
        id: "whisper-turbo",
        kind: ModelKind::Whisper,
        files: &[
            (
                "turbo-encoder.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/main/turbo-encoder.int8.onnx?download=true",
                675_000_000,
            ),
            (
                "turbo-decoder.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/main/turbo-decoder.int8.onnx?download=true",
                361_000_000,
            ),
            (
                "turbo-tokens.txt",
                "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/main/turbo-tokens.txt?download=true",
                800_000,
            ),
        ],
    },
    ModelSpec {
        id: "parakeet-v3",
        kind: ModelKind::NemoTransducer,
        files: &[
            (
                "encoder.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx?download=true",
                652_000_000,
            ),
            (
                "decoder.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx?download=true",
                12_000_000,
            ),
            (
                "joiner.int8.onnx",
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx?download=true",
                7_000_000,
            ),
            (
                "tokens.txt",
                "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt?download=true",
                200_000,
            ),
        ],
    },
];

fn spec_for(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("model tidak dikenal: {id}"))
}

fn model_dir(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("speech-models")
        .join(id))
}

static DOWNLOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(serde::Serialize, Clone)]
pub struct SttDownloadProgress {
    pub model: String,
    pub file: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
}

/// Is a local model fully installed?
#[tauri::command]
pub async fn stt_model_status(app: tauri::AppHandle, model_id: String) -> Result<bool, String> {
    let spec = spec_for(&model_id)?;
    let dir = model_dir(&app, spec.id)?;
    Ok(spec.files.iter().all(|(name, _, _)| dir.join(name).exists()))
}

/// Download a model's files (streamed; progress on `stt-download-progress`).
#[tauri::command]
pub async fn download_stt_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;

    let spec = spec_for(&model_id)?;
    if DOWNLOADING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("download sudah berjalan".into());
    }
    let result: Result<(), String> = async {
        let dir = model_dir(&app, spec.id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let client = reqwest::Client::new();
        // grand-total progress across all files, so multi-file models (Parakeet) show ONE bar
        let grand_total: u64 = spec.files.iter().map(|(_, _, est)| *est).sum();
        let mut grand_received: u64 = 0;
        for (name, url, est) in spec.files {
            let dest = dir.join(name);
            if dest.exists() {
                grand_received += est;
                continue;
            }
            let resp = client.get(*url).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("unduh {name}: HTTP {}", resp.status()));
            }
            let part = dir.join(format!("{name}.part"));
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let mut last_emit = std::time::Instant::now();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                grand_received += chunk.len() as u64;
                if last_emit.elapsed().as_millis() > 200 {
                    last_emit = std::time::Instant::now();
                    let _ = app.emit(
                        "stt-download-progress",
                        SttDownloadProgress {
                            model: spec.id.to_string(),
                            file: name.to_string(),
                            received: grand_received,
                            total: grand_total,
                            done: false,
                        },
                    );
                }
            }
            drop(file);
            std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        }
        let _ = app.emit(
            "stt-download-progress",
            SttDownloadProgress {
                model: spec.id.to_string(),
                file: String::new(),
                received: grand_total,
                total: grand_total,
                done: true,
            },
        );
        Ok(())
    }
    .await;
    DOWNLOADING.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// Transcribe 16 kHz mono PCM16 audio (base64) with a local model.
/// Recognizer is created per call (prototype; a resident worker is the planned optimization).
#[tauri::command]
pub async fn transcribe_local(
    app: tauri::AppHandle,
    model_id: String,
    samples_b64: String,
    sample_rate: u32,
    language: Option<String>,
) -> Result<String, String> {
    let spec = spec_for(&model_id)?;
    let dir = model_dir(&app, spec.id)?;
    if !spec.files.iter().all(|(name, _, _)| dir.join(name).exists()) {
        return Err(format!("Model offline belum terpasang di {}", dir.display()));
    }

    let raw = base64::engine::general_purpose::STANDARD
        .decode(samples_b64.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    if raw.len() < 2 {
        return Err("audio kosong".into());
    }
    let samples: Vec<f32> = raw
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    let p = |name: &str| dir.join(name).to_string_lossy().into_owned();
    let model_config = match spec.kind {
        ModelKind::OmnilingualCtc => OfflineModelConfig {
            omnilingual: OfflineOmnilingualAsrCtcModelConfig {
                model: Some(p("model.int8.onnx")),
            },
            tokens: Some(p("tokens.txt")),
            num_threads: 4,
            ..Default::default()
        },
        ModelKind::Whisper => OfflineModelConfig {
            whisper: OfflineWhisperModelConfig {
                encoder: Some(p("turbo-encoder.int8.onnx")),
                decoder: Some(p("turbo-decoder.int8.onnx")),
                // '' / None = let Whisper auto-detect; the app passes its "From" language
                language: language.clone().filter(|l| !l.is_empty() && l != "auto"),
                task: Some("transcribe".into()),
                ..Default::default()
            },
            tokens: Some(p("turbo-tokens.txt")),
            num_threads: 4,
            ..Default::default()
        },
        ModelKind::NemoTransducer => OfflineModelConfig {
            transducer: OfflineTransducerModelConfig {
                encoder: Some(p("encoder.int8.onnx")),
                decoder: Some(p("decoder.int8.onnx")),
                joiner: Some(p("joiner.int8.onnx")),
            },
            tokens: Some(p("tokens.txt")),
            model_type: Some("nemo_transducer".into()),
            num_threads: 4,
            ..Default::default()
        },
    };

    // sherpa's FFI pointers aren't Send — run on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || {
        let config = OfflineRecognizerConfig {
            model_config,
            ..Default::default()
        };
        let rec = OfflineRecognizer::create(&config)
            .ok_or_else(|| "gagal memuat model offline".to_string())?;
        let stream = rec.create_stream();
        stream.accept_waveform(sample_rate as i32, &samples);
        rec.decode(&stream);
        Ok(stream.get_result().map(|r| r.text).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}
