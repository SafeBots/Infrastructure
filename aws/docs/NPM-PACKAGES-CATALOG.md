# Safebox NPM Package Catalog - Document Generation & Editing

## Overview

Complete set of npm packages for generating and editing documents, spreadsheets, presentations, images, and more. All packages installed in Safebox base AMI.

**Installation Location:** `/opt/safebox/node_modules/`  
**Total Size:** ~200 MB (all packages combined)  
**License:** All MIT or Apache 2.0 (permissive)

---

## Package Categories

### **1. Document Generation (Word/DOCX)**

```json
{
  "docx": "^8.5.0",
  "officegen": "^0.6.5",
  "html-docx-js": "^0.3.1",
  "docx-templates": "^4.11.3"
}
```

**docx** (Primary, ~500 KB)
- Create .docx from scratch with full formatting
- Tables, images, headers/footers, sections
- Styles, numbering, hyperlinks

**Usage:**
```javascript
const { Document, Packer, Paragraph, TextRun } = require('docx');

const doc = new Document({
    sections: [{
        properties: {},
        children: [
            new Paragraph({
                children: [
                    new TextRun({
                        text: "Hello World",
                        bold: true,
                        size: 28
                    })
                ]
            })
        ]
    }]
});

const buffer = await Packer.toBuffer(doc);
```

**officegen** (Alternative, ~800 KB)
- Stream-based generation
- Good for large documents

**html-docx-js** (HTML → DOCX, ~100 KB)
- Convert HTML to .docx
- Preserves basic formatting

**docx-templates** (Template-based, ~200 KB)
- Fill .docx templates with data
- Mustache-style syntax

---

### **2. Spreadsheet Generation (Excel/XLSX)**

```json
{
  "exceljs": "^4.4.0",
  "xlsx": "^0.18.5",
  "xlsx-populate": "^1.21.0",
  "json2csv": "^6.0.0"
}
```

**exceljs** (Primary, ~2 MB)
- Create/read/edit .xlsx files
- Formulas, charts, images, styles
- Cell merging, data validation

**Usage:**
```javascript
const ExcelJS = require('exceljs');

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('Sheet1');

sheet.columns = [
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Age', key: 'age', width: 10 }
];

sheet.addRow({ name: 'Alice', age: 30 });
sheet.addRow({ name: 'Bob', age: 25 });

const buffer = await workbook.xlsx.writeBuffer();
```

**xlsx** (Alternative, ~1 MB)
- Lightweight, fast parsing
- Read/write .xlsx, .xls, .csv
- Good for data extraction

**xlsx-populate** (Template-based, ~500 KB)
- Modify existing .xlsx files
- Preserve formatting

**json2csv** (CSV generation, ~100 KB)
- JSON → CSV conversion
- Custom delimiters, headers

---

### **3. Presentation Generation (PowerPoint/PPTX)**

```json
{
  "pptxgenjs": "^3.12.0",
  "officegen": "^0.6.5"
}
```

**pptxgenjs** (Primary, ~300 KB)
- Create .pptx from scratch
- Slides, shapes, images, charts
- Text formatting, layouts

**Usage:**
```javascript
const PptxGenJS = require('pptxgenjs');

const pptx = new PptxGenJS();
const slide = pptx.addSlide();

slide.addText('Hello World', {
    x: 1,
    y: 1,
    fontSize: 32,
    bold: true
});

slide.addImage({
    path: 'image.png',
    x: 2,
    y: 2,
    w: 4,
    h: 3
});

const buffer = await pptx.write('nodebuffer');
```

---

### **4. PDF Generation**

```json
{
  "pdfkit": "^0.14.0",
  "pdf-lib": "^1.17.1",
  "jspdf": "^2.5.1",
  "html-pdf-node": "^1.0.8"
}
```

**pdfkit** (Primary, ~1 MB)
- Create PDFs from scratch
- Vector graphics, text, images
- Stream-based

**Usage:**
```javascript
const PDFDocument = require('pdfkit');

const doc = new PDFDocument();
doc.fontSize(25).text('Hello World', 100, 100);
doc.addPage().fontSize(12).text('Page 2');

const buffers = [];
doc.on('data', buffers.push.bind(buffers));
doc.on('end', () => {
    const pdfBuffer = Buffer.concat(buffers);
});
doc.end();
```

**pdf-lib** (Modify existing PDFs, ~500 KB)
- Edit existing PDF files
- Merge, split, add pages
- Fill forms

**jspdf** (Browser-compatible, ~800 KB)
- Client-side PDF generation
- Good for simple documents

**html-pdf-node** (HTML → PDF, ~200 KB + Puppeteer)
- Convert HTML to PDF
- Uses Chromium (already in base for other purposes)

---

### **5. Image Generation & Manipulation**

```json
{
  "sharp": "^0.33.2",
  "jimp": "^0.22.10",
  "canvas": "^2.11.2",
  "qrcode": "^1.5.3",
  "svg-captcha": "^1.4.0"
}
```

**sharp** (Primary, ~10 MB with libvips)
- Fast image processing
- Resize, crop, convert formats
- JPEG, PNG, WebP, AVIF, HEIF

**Usage:**
```javascript
const sharp = require('sharp');

const buffer = await sharp(inputBuffer)
    .resize(800, 600, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();
```

**jimp** (Pure JS, ~5 MB)
- No native dependencies
- Image manipulation
- Slower than sharp

**canvas** (HTML5 Canvas API, ~15 MB)
- Server-side canvas
- Draw graphics, text
- Export to PNG/JPEG

**qrcode** (QR codes, ~100 KB)
- Generate QR codes
- PNG, SVG, data URL

**svg-captcha** (CAPTCHA, ~50 KB)
- Generate text CAPTCHAs
- SVG output

---

### **6. Chart & Diagram Generation**

```json
{
  "chartjs-node-canvas": "^4.1.6",
  "mermaid": "^10.9.0",
  "d3-node": "^3.0.0",
  "vega": "^5.27.0",
  "vega-lite": "^5.16.3"
}
```

**chartjs-node-canvas** (Charts, ~2 MB)
- Server-side Chart.js
- Line, bar, pie, scatter charts
- PNG output

**Usage:**
```javascript
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const renderer = new ChartJSNodeCanvas({ width: 800, height: 600 });
const buffer = await renderer.renderToBuffer({
    type: 'bar',
    data: {
        labels: ['A', 'B', 'C'],
        datasets: [{
            label: 'Data',
            data: [10, 20, 15]
        }]
    }
});
```

**mermaid** (Diagrams, ~5 MB)
- Flowcharts, sequence diagrams
- Text-based syntax
- SVG/PNG output

**d3-node** (D3.js server-side, ~2 MB)
- Complex visualizations
- SVG output

**vega/vega-lite** (Declarative viz, ~3 MB)
- JSON-based chart specs
- PNG/SVG output

---

### **7. Archive Creation**

```json
{
  "archiver": "^6.0.1",
  "adm-zip": "^0.5.10",
  "tar-stream": "^3.1.7"
}
```

**archiver** (Primary, ~200 KB)
- Create ZIP/TAR archives
- Stream-based
- Compression levels

**Usage:**
```javascript
const archiver = require('archiver');

const archive = archiver('zip', { zlib: { level: 9 } });
const buffers = [];

archive.on('data', chunk => buffers.push(chunk));
archive.on('end', () => {
    const zipBuffer = Buffer.concat(buffers);
});

archive.append(Buffer.from('content'), { name: 'file.txt' });
archive.append(imageBuffer, { name: 'image.png' });
archive.finalize();
```

**adm-zip** (Simple API, ~100 KB)
- Easy ZIP creation
- In-memory operations

**tar-stream** (TAR archives, ~50 KB)
- Create/extract TAR files
- Stream-based

---

### **8. Email Generation**

```json
{
  "nodemailer": "^6.9.9",
  "mjml": "^4.15.3",
  "handlebars": "^4.7.8"
}
```

**nodemailer** (Email sending, ~500 KB)
- Send emails via SMTP
- HTML/text, attachments
- Templating support

**mjml** (Responsive emails, ~3 MB)
- Email-specific markup
- Converts to responsive HTML
- Works across all clients

**Usage:**
```javascript
const mjml2html = require('mjml');

const html = mjml2html(`
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello World</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`).html;
```

**handlebars** (Templates, ~500 KB)
- Mustache-style templates
- Use for email/document templates

---

### **9. Markdown & Rich Text**

```json
{
  "markdown-it": "^14.0.0",
  "marked": "^12.0.0",
  "turndown": "^7.1.2",
  "slate": "^0.103.0"
}
```

**markdown-it** (MD → HTML, ~100 KB)
- Full-featured Markdown parser
- Plugins for extensions
- Syntax highlighting

**marked** (Lightweight, ~50 KB)
- Fast Markdown parser
- Simple API

**turndown** (HTML → MD, ~80 KB)
- Reverse conversion
- Customizable rules

**slate** (Rich text, ~500 KB)
- Rich text editor framework
- JSON-based document model

---

### **10. Data Transformation**

```json
{
  "papaparse": "^5.4.1",
  "xml2js": "^0.6.2",
  "fast-xml-parser": "^4.3.5",
  "yaml": "^2.3.4",
  "toml": "^3.0.0"
}
```

**papaparse** (CSV parsing, ~100 KB)
- Parse/generate CSV
- Handle large files
- Auto-detect delimiters

**xml2js** (XML ↔ JSON, ~100 KB)
- Convert between XML and JSON
- Configurable parsing

**fast-xml-parser** (Fast XML, ~150 KB)
- Faster than xml2js
- Validation support

**yaml** (YAML, ~200 KB)
- Parse/stringify YAML
- Full spec compliance

**toml** (TOML, ~50 KB)
- Parse/stringify TOML
- Config files

---

### **11. Template Engines**

```json
{
  "handlebars": "^4.7.8",
  "mustache": "^4.2.0",
  "ejs": "^3.1.9",
  "pug": "^3.0.2"
}
```

**handlebars** (Preferred, ~500 KB)
- Logic-less templates
- Partials, helpers
- Widely used

**mustache** (Minimal, ~50 KB)
- Simplest templating
- Cross-language

**ejs** (Embedded JS, ~100 KB)
- JavaScript in templates
- Familiar syntax

**pug** (Indentation-based, ~500 KB)
- HTML templating
- Clean syntax

---

### **12. Barcode & QR Generation**

```json
{
  "qrcode": "^1.5.3",
  "jsbarcode": "^3.11.6",
  "bwip-js": "^4.3.0"
}
```

**qrcode** (QR codes, ~100 KB)
- Generate QR codes
- Various output formats

**jsbarcode** (Barcodes, ~100 KB)
- CODE128, EAN, UPC, etc.
- SVG/Canvas output

**bwip-js** (Advanced barcodes, ~500 KB)
- 100+ barcode formats
- High quality output

---

### **13. Font & Text Utilities**

```json
{
  "opentype.js": "^1.3.4",
  "text-encoding": "^0.7.0",
  "iconv-lite": "^0.6.3",
  "string-width": "^7.1.0"
}
```

**opentype.js** (Font parsing, ~200 KB)
- Parse TrueType/OpenType fonts
- Generate font outlines
- Text measurement

**text-encoding** (Text encoding, ~50 KB)
- TextEncoder/TextDecoder polyfill
- UTF-8, UTF-16

**iconv-lite** (Encoding conversion, ~200 KB)
- Convert text encodings
- Wide format support

**string-width** (Terminal width, ~10 KB)
- Calculate string width
- ANSI codes, emoji

---

### **14. Utilities**

```json
{
  "lodash": "^4.17.21",
  "moment": "^2.30.1",
  "dayjs": "^1.11.10",
  "uuid": "^9.0.1",
  "nanoid": "^5.0.5"
}
```

**lodash** (Utility library, ~1 MB)
- Data manipulation
- Functional programming

**moment** (Date/time, ~500 KB)
- Date manipulation
- Formatting, parsing

**dayjs** (Lightweight date, ~10 KB)
- Moment.js alternative
- Smaller, faster

**uuid** (UUID generation, ~20 KB)
- v1, v4, v5 UUIDs
- RFC4122 compliant

**nanoid** (Short IDs, ~5 KB)
- URL-friendly IDs
- Smaller than UUIDs

---

## External Tool Wrappers

**Pattern:** Thin npm wrappers around system binaries (FFmpeg, pdfium, etc.)

### **Why Wrappers?**

1. **Consistent API:** Node.js promises/streams everywhere
2. **Type Safety:** TypeScript definitions
3. **Error Handling:** Rich error objects
4. **Resource Management:** Auto-cleanup of processes
5. **Testing:** Easy to mock in tests

### **Implementation Pattern**

```javascript
// /opt/safebox/node_modules/@safebox/ffmpeg/index.js

const { spawn } = require('child_process');
const path = require('path');

const FFMPEG_PATH = '/opt/safebox/media/bin/ffmpeg';
const FFPROBE_PATH = '/opt/safebox/media/bin/ffprobe';

class FFmpeg {
    /**
     * Probe video metadata
     * @param {Buffer|string} input - Buffer or file path
     * @returns {Promise<Object>} Metadata object
     */
    static async probe(input) {
        const isBuffer = Buffer.isBuffer(input);
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams'
        ];
        
        if (isBuffer) {
            args.push('pipe:0'); // Read from stdin
        } else {
            args.push(input);
        }
        
        const proc = spawn(FFPROBE_PATH, args);
        
        if (isBuffer) {
            proc.stdin.write(input);
            proc.stdin.end();
        }
        
        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        const errors = [];
        proc.stderr.on('data', chunk => errors.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', (code) => {
                if (code === 0) {
                    const output = Buffer.concat(chunks).toString();
                    const meta = JSON.parse(output);
                    resolve(this._normalizeMetadata(meta));
                } else {
                    reject(new FFmpegError(
                        'Probe failed',
                        Buffer.concat(errors).toString(),
                        code
                    ));
                }
            });
        });
    }
    
    /**
     * Extract audio from video
     * @param {Buffer} input - Video buffer
     * @param {Object} options - Extraction options
     * @returns {Promise<Buffer>} Audio buffer
     */
    static async extractAudio(input, options = {}) {
        const {
            codec = 'opus',
            bitrate = '128k',
            sampleRate = 48000,
            channels = 2
        } = options;
        
        const args = [
            '-i', 'pipe:0',         // Input from stdin
            '-vn',                  // No video
            '-acodec', codec,
            '-ab', bitrate,
            '-ar', sampleRate,
            '-ac', channels,
            '-f', this._getFormat(codec),
            'pipe:1'                // Output to stdout
        ];
        
        const proc = spawn(FFMPEG_PATH, args);
        
        // Write input
        proc.stdin.write(input);
        proc.stdin.end();
        
        // Collect output
        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        
        const errors = [];
        proc.stderr.on('data', chunk => errors.push(chunk));
        
        return new Promise((resolve, reject) => {
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else {
                    reject(new FFmpegError(
                        'Audio extraction failed',
                        Buffer.concat(errors).toString(),
                        code
                    ));
                }
            });
        });
    }
    
    static _normalizeMetadata(meta) {
        const video = meta.streams.find(s => s.codec_type === 'video');
        const audio = meta.streams.find(s => s.codec_type === 'audio');
        
        return {
            duration: parseFloat(meta.format.duration),
            size: parseInt(meta.format.size),
            bitrate: parseInt(meta.format.bit_rate),
            video: video ? {
                codec: video.codec_name,
                width: video.width,
                height: video.height,
                fps: eval(video.r_frame_rate),
                bitrate: parseInt(video.bit_rate || 0)
            } : null,
            audio: audio ? {
                codec: audio.codec_name,
                sampleRate: parseInt(audio.sample_rate),
                channels: audio.channels,
                bitrate: parseInt(audio.bit_rate || 0)
            } : null
        };
    }
    
    static _getFormat(codec) {
        const formats = {
            'opus': 'opus',
            'mp3': 'mp3',
            'flac': 'flac',
            'wav': 'wav',
            'aac': 'adts'
        };
        return formats[codec] || codec;
    }
}

class FFmpegError extends Error {
    constructor(message, stderr, code) {
        super(message);
        this.name = 'FFmpegError';
        this.stderr = stderr;
        this.code = code;
    }
}

module.exports = { FFmpeg, FFmpegError };
```

### **Package Structure**

```
/opt/safebox/node_modules/
├── @safebox/
│   ├── ffmpeg/
│   │   ├── package.json
│   │   ├── index.js
│   │   ├── index.d.ts
│   │   └── README.md
│   ├── pdfium/
│   │   ├── package.json
│   │   ├── index.js
│   │   ├── index.d.ts
│   │   └── README.md
│   ├── imagemagick/
│   │   └── ...
│   └── media/
│       └── index.js        # Re-exports all wrappers
│
├── docx/
├── exceljs/
├── pdfkit/
└── ... (all other npm packages)
```

### **Master Export**

```javascript
// /opt/safebox/node_modules/@safebox/media/index.js

module.exports = {
    FFmpeg: require('@safebox/ffmpeg').FFmpeg,
    PDFium: require('@safebox/pdfium').PDFium,
    ImageMagick: require('@safebox/imagemagick').ImageMagick,
    LibreOffice: require('@safebox/libreoffice').LibreOffice,
    // ... etc
};
```

**Usage in Safebox:**
```javascript
const { FFmpeg, PDFium } = require('@safebox/media');

// All tools available with consistent API
const meta = await FFmpeg.probe(videoBuffer);
const pages = await PDFium.render(pdfBuffer);
```

---

## Complete Package Manifest

```json
{
  "name": "@safebox/packages",
  "version": "1.0.0",
  "description": "Complete npm package catalog for Safebox AMI",
  "private": true,
  "dependencies": {
    // Document Generation
    "docx": "^8.5.0",
    "officegen": "^0.6.5",
    "html-docx-js": "^0.3.1",
    "docx-templates": "^4.11.3",
    
    // Spreadsheets
    "exceljs": "^4.4.0",
    "xlsx": "^0.18.5",
    "xlsx-populate": "^1.21.0",
    "json2csv": "^6.0.0",
    
    // Presentations
    "pptxgenjs": "^3.12.0",
    
    // PDF
    "pdfkit": "^0.14.0",
    "pdf-lib": "^1.17.1",
    "jspdf": "^2.5.1",
    "html-pdf-node": "^1.0.8",
    
    // Images
    "sharp": "^0.33.2",
    "jimp": "^0.22.10",
    "canvas": "^2.11.2",
    "qrcode": "^1.5.3",
    "svg-captcha": "^1.4.0",
    
    // Charts & Diagrams
    "chartjs-node-canvas": "^4.1.6",
    "mermaid": "^10.9.0",
    "d3-node": "^3.0.0",
    "vega": "^5.27.0",
    "vega-lite": "^5.16.3",
    
    // Archives
    "archiver": "^6.0.1",
    "adm-zip": "^0.5.10",
    "tar-stream": "^3.1.7",
    
    // Email
    "nodemailer": "^6.9.9",
    "mjml": "^4.15.3",
    
    // Markdown & Rich Text
    "markdown-it": "^14.0.0",
    "marked": "^12.0.0",
    "turndown": "^7.1.2",
    "slate": "^0.103.0",
    
    // Data Transformation
    "papaparse": "^5.4.1",
    "xml2js": "^0.6.2",
    "fast-xml-parser": "^4.3.5",
    "yaml": "^2.3.4",
    "toml": "^3.0.0",
    
    // Templates
    "handlebars": "^4.7.8",
    "mustache": "^4.2.0",
    "ejs": "^3.1.9",
    "pug": "^3.0.2",
    
    // Barcodes
    "jsbarcode": "^3.11.6",
    "bwip-js": "^4.3.0",
    
    // Font & Text
    "opentype.js": "^1.3.4",
    "text-encoding": "^0.7.0",
    "iconv-lite": "^0.6.3",
    "string-width": "^7.1.0",
    
    // Utilities
    "lodash": "^4.17.21",
    "moment": "^2.30.1",
    "dayjs": "^1.11.10",
    "uuid": "^9.0.1",
    "nanoid": "^5.0.5",
    
    // Office Document Parsing
    "mammoth": "^1.6.0",
    "node-pandoc": "^0.3.0",
    
    // Safebox Wrappers (internal)
    "@safebox/ffmpeg": "file:./wrappers/ffmpeg",
    "@safebox/pdfium": "file:./wrappers/pdfium",
    "@safebox/imagemagick": "file:./wrappers/imagemagick",
    "@safebox/libreoffice": "file:./wrappers/libreoffice",
    "@safebox/media": "file:./wrappers/media"
  }
}
```

---

## Installation

```bash
# In AMI build script
cd /opt/safebox
npm install --production --no-optional
```

**Total Size:** ~200 MB (with all dependencies)  
**Install Time:** ~5 minutes (with caching)

---

## Sandbox Integration

**All packages available in sandbox without imports:**

```javascript
// Sandbox API provides global references
const availablePackages = {
    // Document Generation
    docx: require('docx'),
    officegen: require('officegen'),
    exceljs: require('exceljs'),
    xlsx: require('xlsx'),
    pptxgenjs: require('pptxgenjs'),
    
    // PDF
    pdfkit: require('pdfkit'),
    pdfLib: require('pdf-lib'),
    
    // Images
    sharp: require('sharp'),
    jimp: require('jimp'),
    canvas: require('canvas'),
    qrcode: require('qrcode'),
    
    // Charts
    chartjs: require('chartjs-node-canvas'),
    mermaid: require('mermaid'),
    
    // Archives
    archiver: require('archiver'),
    admZip: require('adm-zip'),
    
    // Email
    nodemailer: require('nodemailer'),
    mjml: require('mjml'),
    
    // Markdown
    markdownIt: require('markdown-it'),
    marked: require('marked'),
    turndown: require('turndown'),
    
    // Data
    papaparse: require('papaparse'),
    xml2js: require('xml2js'),
    fastXmlParser: require('fast-xml-parser'),
    yaml: require('yaml'),
    
    // Templates
    handlebars: require('handlebars'),
    mustache: require('mustache'),
    ejs: require('ejs'),
    
    // Barcodes
    jsbarcode: require('jsbarcode'),
    bwipJs: require('bwip-js'),
    
    // Utilities
    lodash: require('lodash'),
    _: require('lodash'),
    moment: require('moment'),
    dayjs: require('dayjs'),
    uuid: require('uuid'),
    nanoid: require('nanoid'),
    
    // Safebox Wrappers (system tools)
    FFmpeg: require('@safebox/ffmpeg').FFmpeg,
    PDFium: require('@safebox/pdfium').PDFium,
    ImageMagick: require('@safebox/imagemagick').ImageMagick,
    LibreOffice: require('@safebox/libreoffice').LibreOffice,
    
    // Master media wrapper
    Media: require('@safebox/media')
};
```

---

## Summary

**Complete document generation stack:**
- ✅ 50+ npm packages (all MIT/Apache 2.0)
- ✅ DOCX, XLSX, PPTX, PDF, CSV, images, charts
- ✅ Thin wrappers around system tools (FFmpeg, pdfium, etc.)
- ✅ Consistent async/promise API
- ✅ TypeScript definitions
- ✅ ~200 MB total
- ✅ All available in sandbox without imports

**External tools accessed via Node.js wrappers:**
- ✅ FFmpeg (video/audio processing)
- ✅ pdfium (PDF rendering/extraction)
- ✅ ImageMagick (image manipulation)
- ✅ LibreOffice (Office conversion)

**Ready for Safebox workflows!** 🚀
