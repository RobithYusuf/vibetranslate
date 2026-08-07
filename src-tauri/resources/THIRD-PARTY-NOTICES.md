# Third-party notices

VibeTranslate is licensed under the GNU Affero General Public License v3.0; the full text
ships alongside this file as `LICENSE.txt`, and the corresponding source is at
<https://github.com/RobithYusuf/vibetranslate>.

It also includes, or downloads at your request, the following third-party components. Each
remains under its own licence, and nothing below is covered by the AGPL.

## Bundled with the application

| Component | Licence | Used for |
|---|---|---|
| React, React DOM | MIT | user interface |
| Zustand | MIT | application state |
| react-hot-toast | MIT | in-app notifications |
| lucide-react | ISC | icons |
| openai (JS client) | Apache-2.0 | talking to OpenAI-compatible endpoints |
| onnxruntime-web | MIT | running the voice-activity model in the browser layer |
| @ricky0123/vad-web (Silero VAD) | ISC | detecting when you stopped speaking |
| Inter, Geist, Manrope, Plus Jakarta Sans (@fontsource-variable) | SIL Open Font License 1.1 | interface fonts |
| @cloudworxx/tauri-plugin-mac-rounded-corners | MIT | macOS window corners |
| Tauri and its official plugins | MIT / Apache-2.0 | application shell |
| sherpa-onnx | Apache-2.0 | offline speech recognition |

## Downloaded only if you choose an offline model

These are fetched from Hugging Face when you enable offline speech recognition in Settings.
They are not distributed with the installer.

| Model | Licence |
|---|---|
| Omnilingual ASR 300M | see the model card on Hugging Face |
| Whisper large-v3-turbo | MIT |
| Parakeet TDT v3 | CC-BY-4.0 |

If you believe something here is missing or wrong, please open an issue — attribution
mistakes are worth fixing quickly.
