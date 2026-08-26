# Safebox Media & Document Processing - Node.js Library

## Overview

Unified Node.js library for accessing all media and document processing capabilities. Provides clean async API over FFmpeg, pdfium, LibreOffice, ImageMagick, and other native tools.

**Package:** `@safebox/media` (internal, not published to npm)  
**Location:** `/opt/safebox/lib/node_modules/@safebox/media/`  
**License:** MIT

---

## Architecture

### **Design Principles**

1. **Stream-Based:** All I/O uses Node.js streams (no temp files)
2. **Promise API:** Async/await throughout
3. **Type-Safe:** Full TypeScript definitions
4. **Resource-Managed:** Auto-cleanup of child processes
5. **Error-Rich:** Detailed error messages with tool output

### **Tool Execution Pattern**

```javascript
// Base pattern for all tool wrappers
class ToolExecutor {
    async execute(args, input) {
        const proc = spawn(toolPath, args);
        
        // Pipe input if provided
        if (input) {
            input.pipe(proc.stdin);
        }
        
        // Collect output
        const output = [];
        proc.stdout.on('data', chunk => output.push(chunk));
        
        // Collect errors
        const errors = [];
        proc.stderr.on('data', chunk => errors.push(chunk));
        
        // Wait for completion
        return new Promise((resolve, reject) => {
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(output));
                } else {
                    reject(new ToolError(
                        `${this.name} failed with code ${code}`,
                        Buffer.concat(errors).toString(),
                        code
                    ));
                }
            });
        });
    }
}
```

---

## API Reference

### **Document Processing**

#### **PDF**

```typescript
import { PDF } from '@safebox/media';

// Render PDF to images
const pages = await PDF.render(pdfBuffer, {
    dpi: 150,          // Default 72, use 150-300 for OCR
    format: 'png',     // 'png' | 'jpeg' | 'webp'
    quality: 90,       // JPEG/WebP quality (1-100)
    firstPage: 1,      // Optional: start page
    lastPage: 10       // Optional: end page
});
// Returns: Array<{ page: number, buffer: Buffer, width: number, height: number }>

// Extract text with layout
const text = await PDF.extractText(pdfBuffer, {
    preserveLayout: true,   // Maintain spatial layout
    bbox: true              // Include bounding boxes
});
// Returns: Array<{ page: number, text: string, layout?: BBox[] }>

// Get metadata
const meta = await PDF.getMetadata(pdfBuffer);
// Returns: { title, author, subject, creator, producer, creationDate, modDate, pageCount }

// Measure text density (for ingestion pipeline decision)
const density = await PDF.measureTextDensity(pdfBuffer, pageNum);
// Returns: { chars: number, printable: number, ratio: number }
```

**Implementation:**
```javascript
// /opt/safebox/lib/node_modules/@safebox/media/src/pdf.js

const { spawn } = require('child_process');
const path = require('path');

const PDFIUM_PATH = '/opt/safebox/media/bin/pdfium';

class PDF {
    static async render(pdfBuffer, options = {}) {
        const {
            dpi = 72,
            format = 'png',
            quality = 90,
            firstPage = 1,
            lastPage = -1
        } = options;
        
        const args = [
            '--render',
            '--dpi', dpi,
            '--format', format,
            '--quality', quality,
            '--first-page', firstPage
        ];
        
        if (lastPage > 0) {
            args.push('--last-page', lastPage);
        }
        
        const proc = spawn(PDFIUM_PATH, args);
        
        // Write PDF to stdin
        proc.stdin.write(pdfBuffer);
        proc.stdin.end();
        
        // Parse output (NDJSON: one line per page)
        const pages = [];
        let buffer = '';
        
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line
            
            for (const line of lines) {
                if (line.trim()) {
                    const page = JSON.parse(line);
                    pages.push({
                        page: page.num,
                        buffer: Buffer.from(page.data, 'base64'),
                        width: page.width,
                        height: page.height
                    });
                }
            }
        });
        
        return new Promise((resolve, reject) => {
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve(pages);
                } else {
                    reject(new Error(`pdfium render failed: ${code}`));
                }
            });
        });
    }
    
    static async extractText(pdfBuffer, options = {}) {
        const { preserveLayout = true, bbox = false } = options;
        
        const args = ['--extract-text'];
        if (preserveLayout) args.push('--preserve-layout');
        if (bbox) args.push('--bbox');
        
        const proc = spawn(PDFIUM_PATH, args);
        proc.stdin.write(pdfBuffer);
        proc.stdin.end();
        
        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', (code) => {
                if (code === 0) {
                    const output = Buffer.concat(chunks).toString();
                    resolve(JSON.parse(output));
                } else {
                    reject(new Error(`pdfium text extraction failed: ${code}`));
                }
            });
        });
    }
    
    static async measureTextDensity(pdfBuffer, pageNum) {
        const pages = await this.extractText(pdfBuffer);
        const page = pages.find(p => p.page === pageNum);
        
        if (!page) {
            throw new Error(`Page ${pageNum} not found`);
        }
        
        const chars = page.text.length;
        const printable = (page.text.match(/[\x20-\x7E]/g) || []).length;
        
        return {
            chars,
            printable,
            ratio: printable / chars
        };
    }
}

module.exports = { PDF };
```

---

#### **Office Documents**

```typescript
import { Office } from '@safebox/media';

// Extract text from DOCX/XLSX/PPTX (native parsers)
const text = await Office.extractText(docxBuffer, 'docx');
// Returns: { text: string, paragraphs: string[] }

// Convert to PDF (via LibreOffice headless)
const pdfBuffer = await Office.toPDF(docxBuffer, {
    format: 'docx'  // 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp'
});
// Returns: Buffer (PDF)
```

**Implementation:**
```javascript
// /opt/safebox/lib/node_modules/@safebox/media/src/office.js

const mammoth = require('mammoth');        // DOCX
const XLSX = require('xlsx');              // XLSX
const { spawn } = require('child_process');

const LIBREOFFICE_PATH = '/opt/safebox/libreoffice/program/soffice';

class Office {
    static async extractText(buffer, format) {
        switch (format) {
            case 'docx':
                return this._extractDocx(buffer);
            case 'xlsx':
                return this._extractXlsx(buffer);
            case 'pptx':
                return this._extractPptx(buffer);
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }
    
    static async _extractDocx(buffer) {
        const result = await mammoth.extractRawText({ buffer });
        const paragraphs = result.value.split('\n').filter(p => p.trim());
        return {
            text: result.value,
            paragraphs
        };
    }
    
    static async _extractXlsx(buffer) {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const text = [];
        
        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            text.push(csv);
        });
        
        return {
            text: text.join('\n\n'),
            sheets: text
        };
    }
    
    static async toPDF(buffer, options = {}) {
        const { format } = options;
        
        // Write to temp file (LibreOffice requires file input)
        const tmpIn = `/tmp/input.${format}`;
        const tmpOut = '/tmp/output.pdf';
        
        await fs.promises.writeFile(tmpIn, buffer);
        
        const args = [
            '--headless',
            '--convert-to', 'pdf',
            '--outdir', '/tmp',
            tmpIn
        ];
        
        const proc = spawn(LIBREOFFICE_PATH, args);
        
        return new Promise((resolve, reject) => {
            proc.on('exit', async (code) => {
                if (code === 0) {
                    const pdfBuffer = await fs.promises.readFile(tmpOut);
                    
                    // Cleanup
                    await fs.promises.unlink(tmpIn);
                    await fs.promises.unlink(tmpOut);
                    
                    resolve(pdfBuffer);
                } else {
                    reject(new Error(`LibreOffice conversion failed: ${code}`));
                }
            });
        });
    }
}

module.exports = { Office };
```

---

### **Video Processing**

#### **FFmpeg**

```typescript
import { Video } from '@safebox/media';

// Probe video metadata
const meta = await Video.probe(videoBuffer);
// Returns: { duration, width, height, codec, hasAudio, fps, bitrate }

// Extract audio track
const audioBuffer = await Video.extractAudio(videoBuffer, {
    codec: 'opus',        // 'opus' | 'mp3' | 'flac' | 'wav'
    bitrate: '128k',      // Audio bitrate
    sampleRate: 48000     // Sample rate
});
// Returns: Buffer

// Extract keyframes
const frames = await Video.extractKeyframes(videoBuffer, {
    scenes: [              // Scene list from PySceneDetect
        { start: 0, end: 5.2 },
        { start: 5.2, end: 12.8 }
    ],
    format: 'png',        // 'png' | 'jpeg'
    quality: 90           // JPEG quality
});
// Returns: Array<{ scene: number, time: number, buffer: Buffer }>

// Scene detection (wrapper around PySceneDetect)
const scenes = await Video.detectScenes(videoBuffer, {
    threshold: 27,        // Sensitivity (default 27)
    minSceneLen: 15       // Min frames per scene (default 15)
});
// Returns: Array<{ start: number, end: number }>
```

**Implementation:**
```javascript
// /opt/safebox/lib/node_modules/@safebox/media/src/video.js

const { spawn } = require('child_process');
const fs = require('fs').promises;

const FFMPEG_PATH = '/opt/safebox/media/bin/ffmpeg';
const FFPROBE_PATH = '/opt/safebox/media/bin/ffprobe';
const PYSCENEDETECT_PATH = '/opt/safebox/media/bin/scenedetect';

class Video {
    static async probe(buffer) {
        // Write to temp file (ffprobe requires file input)
        const tmpPath = `/tmp/video-${Date.now()}.mp4`;
        await fs.writeFile(tmpPath, buffer);
        
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            tmpPath
        ];
        
        const proc = spawn(FFPROBE_PATH, args);
        const chunks = [];
        
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', async (code) => {
                await fs.unlink(tmpPath);
                
                if (code === 0) {
                    const output = JSON.parse(Buffer.concat(chunks).toString());
                    const video = output.streams.find(s => s.codec_type === 'video');
                    const audio = output.streams.find(s => s.codec_type === 'audio');
                    
                    resolve({
                        duration: parseFloat(output.format.duration),
                        width: video.width,
                        height: video.height,
                        codec: video.codec_name,
                        hasAudio: !!audio,
                        fps: eval(video.r_frame_rate),
                        bitrate: parseInt(output.format.bit_rate)
                    });
                } else {
                    reject(new Error(`ffprobe failed: ${code}`));
                }
            });
        });
    }
    
    static async extractAudio(buffer, options = {}) {
        const {
            codec = 'opus',
            bitrate = '128k',
            sampleRate = 48000
        } = options;
        
        const tmpIn = `/tmp/video-${Date.now()}.mp4`;
        await fs.writeFile(tmpIn, buffer);
        
        const args = [
            '-i', tmpIn,
            '-vn',                    // No video
            '-acodec', codec,
            '-ab', bitrate,
            '-ar', sampleRate,
            '-f', this._getFormat(codec),
            'pipe:1'                  // Output to stdout
        ];
        
        const proc = spawn(FFMPEG_PATH, args);
        const chunks = [];
        
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', async (code) => {
                await fs.unlink(tmpIn);
                
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else {
                    reject(new Error(`ffmpeg audio extraction failed: ${code}`));
                }
            });
        });
    }
    
    static async extractKeyframes(buffer, options = {}) {
        const { scenes, format = 'png', quality = 90 } = options;
        
        const tmpIn = `/tmp/video-${Date.now()}.mp4`;
        await fs.writeFile(tmpIn, buffer);
        
        const frames = [];
        
        for (let i = 0; i < scenes.length; i++) {
            const scene = scenes[i];
            const time = scene.start + (scene.end - scene.start) / 2;
            
            const args = [
                '-ss', time,
                '-i', tmpIn,
                '-vframes', '1',
                '-f', 'image2pipe',
                '-vcodec', format === 'png' ? 'png' : 'mjpeg'
            ];
            
            if (format === 'jpeg') {
                args.push('-q:v', Math.round((100 - quality) / 10));
            }
            
            args.push('pipe:1');
            
            const proc = spawn(FFMPEG_PATH, args);
            const chunks = [];
            
            proc.stdout.on('data', chunk => chunks.push(chunk));
            
            const frameBuffer = await new Promise((resolve, reject) => {
                proc.on('exit', (code) => {
                    if (code === 0) {
                        resolve(Buffer.concat(chunks));
                    } else {
                        reject(new Error(`Frame extraction failed at ${time}s`));
                    }
                });
            });
            
            frames.push({
                scene: i,
                time,
                buffer: frameBuffer
            });
        }
        
        await fs.unlink(tmpIn);
        return frames;
    }
    
    static async detectScenes(buffer, options = {}) {
        const { threshold = 27, minSceneLen = 15 } = options;
        
        const tmpIn = `/tmp/video-${Date.now()}.mp4`;
        await fs.writeFile(tmpIn, buffer);
        
        const args = [
            '-i', tmpIn,
            'detect-content',
            '--threshold', threshold,
            '--min-scene-len', minSceneLen,
            'list-scenes'
        ];
        
        const proc = spawn(PYSCENEDETECT_PATH, args);
        const chunks = [];
        
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', async (code) => {
                await fs.unlink(tmpIn);
                
                if (code === 0) {
                    const output = Buffer.concat(chunks).toString();
                    const scenes = this._parseSceneOutput(output);
                    resolve(scenes);
                } else {
                    reject(new Error(`Scene detection failed: ${code}`));
                }
            });
        });
    }
    
    static _parseSceneOutput(output) {
        const lines = output.split('\n');
        const scenes = [];
        
        for (const line of lines) {
            const match = line.match(/Scene (\d+):\s+Start\s+([\d.]+)s\s+End\s+([\d.]+)s/);
            if (match) {
                scenes.push({
                    start: parseFloat(match[2]),
                    end: parseFloat(match[3])
                });
            }
        }
        
        return scenes;
    }
    
    static _getFormat(codec) {
        const formats = {
            'opus': 'opus',
            'mp3': 'mp3',
            'flac': 'flac',
            'wav': 'wav'
        };
        return formats[codec] || codec;
    }
}

module.exports = { Video };
```

---

### **Image Processing**

```typescript
import { Image } from '@safebox/media';

// Convert format
const pngBuffer = await Image.convert(jpegBuffer, {
    from: 'jpeg',
    to: 'png'
});

// Resize
const resized = await Image.resize(buffer, {
    width: 800,
    height: 600,
    fit: 'cover',      // 'cover' | 'contain' | 'fill'
    quality: 90
});

// Get metadata
const meta = await Image.getMetadata(buffer);
// Returns: { width, height, format, hasAlpha, exif: {...} }
```

---

### **Archive Processing**

```typescript
import { Archive } from '@safebox/media';

// Extract archive
const files = await Archive.extract(zipBuffer, {
    filter: (entry) => !entry.name.startsWith('__MACOSX/')
});
// Returns: Array<{ name: string, buffer: Buffer, isDirectory: boolean }>

// List contents (without extracting)
const entries = await Archive.list(zipBuffer);
// Returns: Array<{ name: string, size: number, isDirectory: boolean }>
```

---

## Workflow Integration

### **Document Ingestion Example**

```javascript
const { PDF, Office } = require('@safebox/media');
const { Streams } = require('@safebox/core');

async function ingestDocument(docStream, docType) {
    const buffer = await streamToBuffer(docStream);
    
    // Step 1: Convert to PDF if needed
    let pdfBuffer;
    if (docType === 'pdf') {
        pdfBuffer = buffer;
    } else {
        pdfBuffer = await Office.toPDF(buffer, { format: docType });
    }
    
    // Step 2: Render pages
    const pages = await PDF.render(pdfBuffer, { dpi: 150 });
    
    // Step 3: Extract text
    const textPages = await PDF.extractText(pdfBuffer, {
        preserveLayout: true,
        bbox: true
    });
    
    // Step 4: Process each page
    for (let i = 0; i < pages.length; i++) {
        const pageImage = pages[i];
        const pageText = textPages.find(p => p.page === pageImage.page);
        
        // Measure text density
        const density = {
            chars: pageText.text.length,
            printable: (pageText.text.match(/[\x20-\x7E]/g) || []).length
        };
        density.ratio = density.printable / density.chars;
        
        // Decision: text-based or OCR
        if (density.chars >= 200 && density.ratio >= 0.8) {
            // High text density: use extracted text
            await embedTextChunks(pageText.text, pageImage.page);
        } else {
            // Low text density: use OCR
            await ocrAndEmbed(pageImage.buffer, pageImage.page);
        }
        
        // Always: visual embedding (eager)
        await visualEmbedPage(pageImage.buffer, pageImage.page);
    }
}
```

### **Video Ingestion Example**

```javascript
const { Video } = require('@safebox/media');

async function ingestVideo(videoStream) {
    const buffer = await streamToBuffer(videoStream);
    
    // Step 1: Probe metadata
    const meta = await Video.probe(buffer);
    
    // Step 2: Detect scenes
    const scenes = await Video.detectScenes(buffer, {
        threshold: 27,
        minSceneLen: 15
    });
    
    // Step 3: Extract keyframes
    const keyframes = await Video.extractKeyframes(buffer, {
        scenes,
        format: 'png'
    });
    
    // Step 4: Visual embedding per keyframe
    for (const frame of keyframes) {
        await visualEmbedKeyframe(frame.buffer, {
            scene: frame.scene,
            time: frame.time
        });
    }
    
    // Step 5: Audio transcription (if present)
    if (meta.hasAudio) {
        const audioBuffer = await Video.extractAudio(buffer, {
            codec: 'wav',  // For Whisper
            sampleRate: 16000
        });
        
        await transcribeAndEmbed(audioBuffer);
    }
}
```

---

## Package Structure

```
/opt/safebox/lib/node_modules/@safebox/media/
├── package.json
├── index.js              # Main exports
├── src/
│   ├── pdf.js            # PDF operations
│   ├── office.js         # Office docs
│   ├── video.js          # Video processing
│   ├── image.js          # Image processing
│   ├── archive.js        # Archive handling
│   ├── audio.js          # Audio processing
│   └── errors.js         # Custom error types
├── types/
│   └── index.d.ts        # TypeScript definitions
└── README.md
```

---

## Error Handling

```typescript
import { ToolError } from '@safebox/media';

try {
    const pages = await PDF.render(buffer);
} catch (error) {
    if (error instanceof ToolError) {
        console.error('Tool:', error.tool);
        console.error('Exit code:', error.code);
        console.error('Stderr:', error.stderr);
    }
}

// Custom error class
class ToolError extends Error {
    constructor(message, stderr, code) {
        super(message);
        this.name = 'ToolError';
        this.stderr = stderr;
        this.code = code;
    }
}
```

---

## Summary

**Complete Node.js library for accessing native tools:**
- ✅ PDF rendering and text extraction (pdfium)
- ✅ Office document conversion (LibreOffice)
- ✅ Video processing (FFmpeg, PySceneDetect)
- ✅ Image processing (libvips, ImageMagick)
- ✅ Archive handling (libarchive)
- ✅ Stream-based API (no temp files when possible)
- ✅ Full TypeScript support
- ✅ Clean error handling
- ✅ Resource cleanup

**Ready for workflow integration in Safebox streams!** 🚀
