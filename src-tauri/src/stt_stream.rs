//! Live dictation: incremental speech recognition while the user is still speaking.
//!
//! Different in shape from `stt.rs`, which decodes one finished recording in a single call.
//! Here the recogniser and its stream must OUTLIVE each call — the stream's accumulated state
//! is precisely what lets later audio correct earlier words — so both live in a resident
//! session that `stream_stt_push` feeds 200ms at a time.
//!
//! What this deliberately does NOT do: type into the user's application as they speak. Partial
//! hypotheses revise themselves ("saya mau" becomes "saya mau makan", and earlier words can
//! change too), and this app inserts text by clipboard and synthetic keystrokes, with no
//! handle on the target's document or undo stack. Every comparable cross-app tool — Wispr
//! Flow, Superwhisper, Aqua Voice — shows live text in its own window and inserts once, at the
//! end. The ones that type live (macOS Dictation, Windows Voice Access, VS Code Speech) can
//! only do it because the OS or the editor owns the text model.
use crate::dlog;
use base64::Engine as _;
use sherpa_onnx::{
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};
use tauri::{Emitter, Manager};

/// Emitted to the overlay as text firms up. Rate-limited by the caller.
#[derive(Clone, serde::Serialize)]
pub struct PartialTranscript {
    pub text: String,
    /// True once the utterance has been finalised — the overlay stops showing it as provisional.
    pub is_final: bool,
}

struct Session {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    last_emitted: String,
    last_emit_at: std::time::Instant,
}

impl Session {
    /// Start a fresh utterance on the SAME loaded model.
    ///
    /// A NEW stream, not `recognizer.reset()`. Reset is for an endpoint boundary inside a live
    /// stream; once `input_finished()` has been called the stream is done, and reusing it made
    /// the next dictation hand back the PREVIOUS one's text — the user saw their sentence
    /// pasted twice. Creating a stream is cheap; it is the model behind it that costs seconds
    /// and hundreds of megabytes, and that is what stays.
    fn renew(&mut self) {
        self.stream = self.recognizer.create_stream();
        self.last_emitted.clear();
        self.last_emit_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
    }
}

// A Mutex, not a channel: pushes arrive in order from one webview and each must finish decoding
// before the next is accepted, or partial results would interleave into nonsense.
static SESSION: std::sync::Mutex<Option<Session>> = std::sync::Mutex::new(None);

/// The recogniser looks ahead (this model is chunk-16-left-128), so the final words never come
/// out until it has seen silence past them. Without this a dictation loses its last word every
/// single time — which reads as a bad model rather than a caller that stopped feeding it.
const TAIL_SILENCE_MS: usize = 500;

/// The overlay only needs to look alive. More than this is wasted IPC and wasted React renders.
const MIN_EMIT_INTERVAL_MS: u128 = 200;

fn model_dir(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("speech-models")
        .join(id))
}

#[tauri::command]
pub async fn stream_stt_start(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    dlog!("[LiveSTT] start requested: {model_id}");
    let dir = model_dir(&app, &model_id)?;
    let f = |n: &str| dir.join(n).to_string_lossy().to_string();

    let encoder = f("encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx");
    let decoder = f("decoder-epoch-75-avg-11-chunk-16-left-128.onnx");
    let joiner = f("joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx");
    let tokens = f("tokens.txt");
    for p in [&encoder, &decoder, &joiner, &tokens] {
        if !std::path::Path::new(p).exists() {
            return Err(format!("model belum lengkap: {p}"));
        }
    }

    let cfg = OnlineRecognizerConfig {
        model_config: OnlineModelConfig {
            transducer: OnlineTransducerModelConfig {
                encoder: Some(encoder),
                decoder: Some(decoder),
                joiner: Some(joiner),
            },
            tokens: Some(tokens),
            num_threads: 2,
            ..Default::default()
        },
        // Endpointing stays OFF: Silero in the overlay already decides when the user stopped
        // talking, and two independent endpointers would race to end the same utterance.
        enable_endpoint: false,
        ..Default::default()
    };

    {
        let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = guard.as_mut() {
            s.renew(); // already warm: nothing to load, the shortcut is ready at once
            return Ok(());
        }
    }

    // Load OUTSIDE the lock. Holding it across the multi-second 340MB load parked every
    // other command on the mutex — pressing Esc during a cold start left stream_stt_cancel
    // blocked for the whole load, so the cancel visibly did nothing.
    let t0 = std::time::Instant::now();
    let recognizer = tauri::async_runtime::spawn_blocking(move || OnlineRecognizer::create(&cfg))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("gagal memuat model live")?;
    dlog!("[LiveSTT] model loaded in {}ms", t0.elapsed().as_millis());

    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_mut() {
        // Two starts raced; the earlier winner is already warm. Renew it and drop ours.
        s.renew();
        return Ok(());
    }
    let stream = recognizer.create_stream();
    *guard = Some(Session {
        recognizer,
        stream,
        last_emitted: String::new(),
        last_emit_at: std::time::Instant::now() - std::time::Duration::from_secs(1),
    });
    Ok(())
}

/// Feed one chunk of PCM. `samples_b64` is base64 of little-endian i16 mono at `sample_rate`.
#[tauri::command]
pub async fn stream_stt_push(
    app: tauri::AppHandle,
    samples_b64: String,
    sample_rate: i32,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(samples_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let Some(s) = guard.as_mut() else {
        // Not an error: a chunk in flight when the user cancelled is expected.
        dlog!("[LiveSTT] push dropped: no session");
        return Ok(());
    };

    // Kept after the outage it exposed: a JS-side bug meant this function was never called at
    // all, and the only reason that was provable — rather than guessable against "the mic is
    // broken" — was a counter that prints on chunk #0. dlog compiles away in release.
    {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n % 25 == 0 {
            let rms = (samples.iter().map(|v| v * v).sum::<f32>() / samples.len().max(1) as f32).sqrt();
            dlog!("[LiveSTT] push #{n}: {} samples @{}Hz rms={:.4}", samples.len(), sample_rate, rms);
        }
    }
    s.stream.accept_waveform(sample_rate, &samples);
    while s.recognizer.is_ready(&s.stream) {
        s.recognizer.decode(&s.stream);
    }

    if let Some(r) = s.recognizer.get_result(&s.stream) {
        let changed = r.text != s.last_emitted && !r.text.is_empty();
        let due = s.last_emit_at.elapsed().as_millis() >= MIN_EMIT_INTERVAL_MS;
        if changed && due {
            dlog!("[LiveSTT] partial: {:?}", &r.text.chars().take(60).collect::<String>());
            s.last_emitted = r.text.clone();
            s.last_emit_at = std::time::Instant::now();
            let _ = app.emit(
                "live-transcript",
                PartialTranscript { text: r.text, is_final: false },
            );
        }
    }
    Ok(())
}

/// End the utterance and return the final text. Always tears the session down.
#[tauri::command]
pub async fn stream_stt_finish(app: tauri::AppHandle) -> Result<String, String> {
    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let Some(s) = guard.as_mut() else {
        // Session already gone (live toggled off mid-dictation): still send the final
        // marker, or the transcript window keeps the abandoned sentence in state.
        let _ = app.emit("live-transcript", PartialTranscript { text: String::new(), is_final: true });
        return Ok(String::new());
    };

    let tail = vec![0f32; 16000 * TAIL_SILENCE_MS / 1000];
    s.stream.accept_waveform(16000, &tail);
    s.stream.input_finished();
    while s.recognizer.is_ready(&s.stream) {
        s.recognizer.decode(&s.stream);
    }
    let text = s
        .recognizer
        .get_result(&s.stream)
        .map(|r| r.text)
        .unwrap_or_default();
    dlog!("[LiveSTT] finish: {} chars", text.len());

    // Kept loaded on purpose. Dropping it here would make the NEXT shortcut press wait for a
    // few hundred megabytes to load again — the delay the user loses their first words to.
    // stream_stt_release frees it when live dictation is switched off.
    if let Some(s) = guard.as_mut() {
        s.renew();
    }
    let _ = app.emit(
        "live-transcript",
        PartialTranscript { text: text.clone(), is_final: true },
    );
    Ok(text)
}

/// Throw the session away without producing text (user cancelled).
#[tauri::command]
pub async fn stream_stt_cancel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(s) = SESSION.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        s.renew();
    }
    // The overlay clears its text only on an is_final event; without one a cancelled
    // session's sentence lingered and flashed up when the window was next shown.
    let _ = app.emit("live-transcript", PartialTranscript { text: String::new(), is_final: true });
    Ok(())
}

/// Free the model. Called when live dictation is turned off — there is no reason to hold a few
/// hundred megabytes for a feature the user has switched away from.
#[tauri::command]
pub async fn stream_stt_release() -> Result<(), String> {
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}
