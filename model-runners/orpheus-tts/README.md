# orpheus-tts runner (also hosts Higgs Audio v2)

Commercial-safe (Apache-2.0) expressive / high-naturalness TTS built on Llama
architectures, so they fit an LLM-style serving stack (vLLM / SGLang) cleanly.

- `manifests/orpheus-3b.json` — Canopy AI Orpheus, Apache-2.0. Expressive/emotional
  pick; guided-emotion tags, zero-shot cloning, ~100-200ms streaming. Sizes 150M-3B.
- `manifests/higgs-audio-v2-3b.json` — Boson AI Higgs Audio **v2**, Apache-2.0.
  Naturalness/quality pick; multi-speaker, speech+background-music; vLLM-Omni servable.

*** LICENSE LANDMINE: Higgs Audio **v3** is NON-COMMERCIAL — do not use v3 for
Safebux-metered serving. This runner pins v2 (Apache) only. ***
