# MinerU Document Extraction Runner

**MinerU 2.5 as a Safebox Local Service**

Converts PDFs, scanned images, Word docs, PowerPoint, and Excel into LLM-ready Markdown and JSON. VLM + OCR dual engine, 109 languages, math formulas as LaTeX, tables as structured cells, multi-column reading order preserved.

Built on [opendatalab/MinerU](https://github.com/opendatalab/MinerU) (Shanghai AI Laboratory / OpenDataLab, Apache 2.0).

---

## 🎯 What It Does

**Input formats:**
- PDF (text-native and scanned)
- DOCX, PPTX, XLSX
- Images (PNG, JPG, TIFF)

**Output formats:**
- Markdown (LLM-ready, headings preserved)
- JSON (structured: blocks, tables, formulas, images, reading order)
- HTML (for tables specifically)

**What it preserves:**
- Reading order across multi-column layouts (top-to-bottom within columns, not left-to-right across the page)
- Math formulas as LaTeX
- Tables as structured cells (merged cells, multi-row headers, page-spanning tables)
- Image cropping and captions
- Handwriting (where the underlying OCR can resolve it)

**Languages:** 109, including all major Latin scripts, Chinese (simplified and traditional), Japanese, Korean, Arabic, Hebrew, Cyrillic, Devanagari.

---

## 🚀 Quick Start

### Build

```bash
cd model-runners/mineru
docker build -t safebox/mineru:latest .
```

### Run

```bash
docker run -d \
  --name safebox-mineru \
  --network safebox-net \
  -e SERVICE_ID=mineru-1 \
  -e ENABLE_UNIX_SOCKET=true \
  -e SAFEBOX_SOCKET_PATH=/run/safebox/services/mineru-1.sock \
  -e MINERU_BACKEND=pipeline \
  -v safebox-sockets:/run/safebox/services \
  -v /etc/safebox:/etc/safebox:ro \
  -v safebox-mineru-models:/root/.cache/mineru \
  -v safebox-mineru-work:/data \
  safebox/mineru:latest
```

The `safebox-mineru-models` volume caches the underlying weights (~3 GB on first run); `safebox-mineru-work` is scratch space for intermediate page rasterizations.

**GPU is optional but recommended.** Without one, MinerU falls back to CPU at roughly 8-10x slower throughput. Add `--gpus all` to the run command if Safebox is provisioned with NVIDIA hardware.

### Test

```bash
curl -X POST --unix-socket /run/safebox/services/mineru-1.sock \
  http://localhost/v1/extract \
  -H "Content-Type: application/json" \
  -H "X-Safebox-Request-Id: test-123" \
  -d '{
    "model": "opendatalab/mineru-2.5",
    "source": "file:///data/test.pdf",
    "output": "markdown",
    "extractImages": true,
    "extractFormulas": true,
    "extractTables": true
  }'
```

**Response (abbreviated):**

```json
{
  "model": "opendatalab/mineru-2.5",
  "markdown": "# Title\n\n## Section 1\n\nBody text...\n\n$$E = mc^2$$\n\n| Col A | Col B |\n|---|---|\n| ... |\n",
  "pageCount": 47,
  "blocks": [
    { "type": "title",    "page": 1, "level": 1, "text": "..." },
    { "type": "text",     "page": 1, "text": "..." },
    { "type": "formula",  "page": 3, "latex": "E = mc^2" },
    { "type": "table",    "page": 5, "html": "<table>...</table>" },
    { "type": "image",    "page": 7, "url": "/data/extracted/img-001.png", "caption": "..." }
  ],
  "usage": {
    "pagesProcessed": 47,
    "elapsedMs": 38214
  }
}
```

---

## 📞 How Safebox Calls It

### From Protocol.Documents.Local

```javascript
// In Safebox
const result = await Protocol.Documents.Local({
    model: 'opendatalab/mineru-2.5',
    source: '/data/contracts/2026-Q2-master.pdf',
    output: 'markdown',
    extractTables: true,
    extractFormulas: true
});

// Drop the Markdown straight into an agent prompt:
const answer = await Protocol.LLM.Local({
    model: 'kimi-k2.6',
    messages: [
        { role: 'system', content: 'You are reviewing this contract.' },
        { role: 'user',   content: result.markdown }
    ]
});
```

### As a Streams hook — auto-extract on upload

```php
<?php
// When a Files/file stream is created with a document MIME type,
// extract its text content into a sibling Documents/extracted stream.
Streams::listen('Streams/post/save', 'after', function($params) {
    $stream = $params['stream'];
    if ($stream->type !== 'Files/file') return;
    $mime = $stream->getAttribute('mimeType');
    if (!preg_match('#^(application/pdf|application/vnd\.|image/)#', $mime)) return;

    $result = Protocol_Documents::Local([
        'model' => 'opendatalab/mineru-2.5',
        'source' => $stream->getAttribute('localPath'),
        'output' => 'markdown'
    ]);

    Streams::create([
        'publisherId' => $stream->publisherId,
        'name'        => 'Documents/extracted/' . $stream->getId(),
        'type'        => 'Documents/extracted',
        'content'     => $result['markdown'],
        'attributes'  => [
            'sourceStream' => $stream->name,
            'pageCount'    => $result['pageCount'],
            'tables'       => count(array_filter($result['blocks'], fn($b) => $b['type']==='table')),
            'formulas'     => count(array_filter($result['blocks'], fn($b) => $b['type']==='formula')),
        ]
    ]);
});
```

### In a workflow

```javascript
// Workflow: "Index uploaded PDFs for search"
async function indexDocument(filePath) {
    // 1. Extract clean text
    const extracted = await Protocol.Documents.Local({
        model: 'opendatalab/mineru-2.5',
        source: filePath,
        output: 'markdown'
    });

    // 2. (Optional) Redact PII before indexing
    const cleaned = await Protocol.Privacy.Local({
        model: 'privacy-filter',
        text: extracted.markdown,
        mode: 'mask'
    });

    // 3. Embed and index
    const chunks = chunkMarkdown(cleaned.redactedText);
    for (const chunk of chunks) {
        const embedding = await Protocol.Embedding.Local({
            model: 'bge-large-en-v1.5',
            text: chunk.text
        });
        await vectorDB.index({ ...chunk, embedding });
    }
}
```

---

## ⚙️ Backends

MinerU 2.5 ships two backends. Pick at container start via `MINERU_BACKEND`:

| Backend  | When to use | Speed | Memory |
|---|---|---|---|
| `pipeline` (default) | Most production workloads. Modular: layout detection → OCR → formula recognition → table parsing. Mature and predictable. | Faster | Lower (~6 GB GPU) |
| `vlm`    | Highest fidelity on complex documents with mixed scripts, dense formulas, or unusual layouts. Single end-to-end vision-language model. | Slower | Higher (~16 GB GPU) |

For everyday extraction (contracts, invoices, papers in Latin scripts), `pipeline` is the right default. Switch to `vlm` for the hard documents that `pipeline` doesn't handle well — they typically run as a fallback queue.

---

## 📊 Capabilities

**GET /v1/capabilities:**

```json
{
  "version": "1.0",
  "runnerType": "document-extraction",
  "serviceId": "mineru-1",
  "transport": {
    "socket": { "path": "/run/safebox/services/mineru-1.sock" }
  },
  "models": {
    "loaded": ["opendatalab/mineru-2.5"],
    "backend": "pipeline"
  },
  "capabilities": {
    "inputFormats":  ["pdf", "docx", "pptx", "xlsx", "png", "jpg", "tiff"],
    "outputFormats": ["markdown", "json", "html"],
    "languages":     109,
    "tables":        true,
    "formulas":      true,
    "ocr":           true,
    "multiColumn":   true,
    "readingOrder":  true,
    "batch":         true,
    "maxPages":      10000
  },
  "health": "healthy"
}
```

---

## 🔐 Privacy Guarantees

**Key property:** documents never leave the Safebox.

- ✅ No API calls to external services (the cloud `mineru.net` SDK is not wired in)
- ✅ Network egress restricted to Unix socket (`SOCKET_ONLY=true` by default)
- ✅ Model weights baked into the image or cached locally on first run
- ✅ Extracted text lives in your Streams, not in MinerU's process memory after the response
- ✅ Source files mounted read-only into the container

**For the auditor:** every extraction request is logged with the source file's SHA-256, the output blob's SHA-256, the model version, and the timestamp. Re-runnable from the same input bytes — a property MinerU explicitly preserves for the pipeline backend.

---

## ⚡ Performance

**Hardware:**
- CPU-only mode: ~6-10 seconds/page on 8-core x86_64
- Single consumer GPU (8 GB): ~0.5-1 second/page on the pipeline backend
- Single datacenter GPU (24 GB+): ~0.2-0.5 second/page; runs the VLM backend comfortably

**Throughput (pipeline backend, single GPU):**
- 200-page PDF: ~90 seconds
- 50-paper batch (~30 pages each): ~12 minutes
- 1,000-image scan batch: ~10 minutes

**Memory:**
- ~6 GB GPU RAM, pipeline backend
- ~16 GB GPU RAM, VLM backend
- ~3 GB model cache on disk

**Scaling:**
- Stateless across requests — safe to run multiple instances behind a load balancer
- Long jobs (10k+ pages) use streaming output to avoid OOM

---

## ✅ Use Cases

1. **Document Q&A** — Extract PDF, hand text to an LLM, ask questions
2. **Contract search** — Index extracted clauses in a vector store for fast retrieval
3. **Invoice ingestion** — Pull line-item tables straight into a spreadsheet or database
4. **Research synthesis** — Extract figures, tables, and equations from academic PDFs for review
5. **Compliance review** — Search every clause across thousands of contracts simultaneously
6. **Legal discovery** — Convert evidence PDFs (often scanned) to searchable text

---

## 💰 Why It's In The Roster

Document extraction has been a per-vendor mess for decades:

| Tool | Cost (2026) | Tables | Formulas | Scanned | Privacy |
|---|---|---|---|---|---|
| Adobe Acrobat Pro | $239.88/yr | ⚠️ Loses merged cells | ❌ | ⚠️ Partial | ❌ Cloud |
| ABBYY FineReader Corporate | $165/yr | ✅ | ❌ | ✅ | ⚠️ Mixed |
| Mistral OCR | $2/1,000 pages | ✅ | ✅ | ✅ | ❌ Cloud |
| **MinerU on Safebox** | **$0** | ✅ | ✅ LaTeX | ✅ | ✅ Local |

Per-page pricing for cloud OCR adds up fast at the volume Safebox tenants hit. A law firm doing 50,000 pages a month at Mistral's rate is paying $100/month and shipping every page to Paris. The same workload on MinerU-on-Safebox is the GPU power bill — and the pages never leave the room.

---

## 📚 References

- GitHub: [opendatalab/MinerU](https://github.com/opendatalab/MinerU) — 68k+ stars
- Cloud version (not used by Safebox): [mineru.net](https://mineru.net)
- Paper 1: [MinerU: An Open-Source Solution for Precise Document Content Extraction](https://arxiv.org/abs/2409.18839) (Wang et al., 2024)
- Paper 2: [MinerU 2.5: A Decoupled Vision-Language Model for Efficient High-Resolution Document Parsing](https://arxiv.org/abs/2509.22501) (Niu et al., 2025)
- License: Apache 2.0 (with a small upstream MinerU clause for commercial use of pre-trained weights — read it for your deployment)

---

## 🎉 Production Ready

✅ Spec-compliant endpoints (`/v1/extract`, `/v1/extract/batch`, `/v1/capabilities`)
✅ Safebox-canonical request/response
✅ Unix socket transport
✅ Header conventions (`X-Safebox-*`)
✅ HMAC-signed requests
✅ Audit-trail compatible
✅ Local-only (no network egress)
✅ Idempotent (same input → same output, hash-verifiable)
