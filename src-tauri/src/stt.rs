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

/// One downloadable file of a model.
///
/// The URL is pinned to an immutable commit revision, not to `resolve/main`. `main` is a
/// moving reference on a THIRD PARTY's repository: whatever sat at that path the moment a
/// user pressed Download became whatever got loaded into the ONNX runtime. `sha256` is the
/// second half of that fix — a pinned revision cannot change, but a compromised CDN or a
/// tampered response still can, and this is checked before the file is put into place.
struct ModelFile {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// Size estimate so the progress bar means something before Content-Length arrives.
    size_hint: u64,
}

struct ModelSpec {
    id: &'static str,
    kind: ModelKind,
    files: &'static [ModelFile],
}

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "omnilingual-300m",
        kind: ModelKind::OmnilingualCtc,
        files: &[
            ModelFile {
                name: "model.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/6abf1ece20cd2308bdb7d13cd78ec1c44fa4c094/model.int8.onnx?download=true",
                sha256: "e7c4e54ee4c4c47829cc6667d5d00ed8ea7bef1dcfeef0fce766f77752a2726c",
                size_hint: 365_000_000,
            },
            ModelFile {
                name: "tokens.txt",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12/resolve/6abf1ece20cd2308bdb7d13cd78ec1c44fa4c094/tokens.txt?download=true",
                sha256: "a7a044c52cb29cbe8b0dc1953e92cefd4ca16b0ed968177b6beab21f9a7d0b31",
                size_hint: 90_000,
            },
        ],
    },
    ModelSpec {
        id: "whisper-turbo",
        kind: ModelKind::Whisper,
        files: &[
            ModelFile {
                name: "turbo-encoder.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-encoder.int8.onnx?download=true",
                sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
                size_hint: 675_000_000,
            },
            ModelFile {
                name: "turbo-decoder.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-decoder.int8.onnx?download=true",
                sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
                size_hint: 361_000_000,
            },
            ModelFile {
                name: "turbo-tokens.txt",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/turbo-tokens.txt?download=true",
                sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
                size_hint: 800_000,
            },
        ],
    },
    ModelSpec {
        id: "parakeet-v3",
        kind: ModelKind::NemoTransducer,
        files: &[
            ModelFile {
                name: "encoder.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/encoder.int8.onnx?download=true",
                sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
                size_hint: 652_000_000,
            },
            ModelFile {
                name: "decoder.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/decoder.int8.onnx?download=true",
                sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
                size_hint: 12_000_000,
            },
            ModelFile {
                name: "joiner.int8.onnx",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/joiner.int8.onnx?download=true",
                sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
                size_hint: 7_000_000,
            },
            ModelFile {
                name: "tokens.txt",
                url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt?download=true",
                sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
                size_hint: 200_000,
            },
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
    Ok(spec.files.iter().all(|f| dir.join(f.name).exists()))
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
        let grand_total: u64 = spec.files.iter().map(|f| f.size_hint).sum();
        let mut grand_received: u64 = 0;
        for spec_file in spec.files {
            let (name, url, est) = (spec_file.name, spec_file.url, spec_file.size_hint);
            let dest = dir.join(name);
            if dest.exists() {
                grand_received += est;
                continue;
            }
            let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("unduh {name}: HTTP {}", resp.status()));
            }
            let part = dir.join(format!("{name}.part"));
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            // Hashed while streaming: these files reach 675MB, so reading them a second time
            // just to check them would double the wait on a slow connection.
            let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
            let mut last_emit = std::time::Instant::now();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                sha2::Digest::update(&mut hasher, &chunk);
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
            // Verify BEFORE the file is put into place. A mismatch means the bytes are not the
            // reviewed model — the .part is deleted rather than left behind, so a retry starts
            // clean instead of resuming a file that is already wrong.
            let got = format!("{:x}", sha2::Digest::finalize(hasher));
            if got != spec_file.sha256 {
                let _ = std::fs::remove_file(&part);
                return Err(format!(
                    "{name}: berkas tidak cocok dengan yang seharusnya (sha256 {} != {}) - unduhan dibatalkan",
                    &got[..16],
                    &spec_file.sha256[..16]
                ));
            }
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
    if !spec.files.iter().all(|f| dir.join(f.name).exists()) {
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
