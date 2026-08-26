# chatterbox-tts runner

Resemble AI's Chatterbox family (MIT). Commercial-safe expressive TTS with
zero-shot voice cloning, emotion control, and native paralinguistic tags.

- `manifests/chatterbox-turbo.json` — 350M, English, fast (~75ms), MIT. Fish-S2 replacement.
- `manifests/chatterbox-multilingual.json` — 23 languages, MIT.

All output carries Resemble's PerTh neural watermark (imperceptible, ~100%
detectable). Surface this to tenants. An ONNX build exists for the onnx runner.
Follows the standard runner contract (SHA-256-manifested weights, HMAC + audit-hash,
dynamic launch via /models/install -> /system start).
