# Safebox Composable Manifests - Cascading Configuration System

## Overview

Each Safebox AMI component provides a manifest JSON file. The sandbox loads and merges these manifests in order, creating a complete capability catalog.

**Pattern:** Base manifest + component manifests = complete runtime environment

---

## Manifest Locations

### **Well-Known Paths**

```
/opt/safebox/manifests/
├── base.json                      # Always present (base AMI)
├── media.json                     # If media component installed
├── libreoffice.json               # If libreoffice component installed
├── vision.json                    # If vision component installed
├── vision-hq.json                 # If vision-hq component installed
├── embed.json                     # If embed component installed
├── speech.json                    # If speech component installed
├── speech-hq.json                 # If speech-hq component installed
├── ocr.json                       # If ocr component installed
├── llm-tiny.json                  # If llm-tiny component installed
├── llm-small.json                 # If llm-small component installed
├── llm-medium.json                # If llm-medium component installed
├── llm-large.json                 # If llm-large component installed
├── llm-xl.json                    # If llm-xl component installed
├── cuda.json                      # If cuda component installed
├── vllm.json                      # If vllm component installed
├── diffusion-small.json           # If diffusion-small component installed
├── index.json                     # If index component installed
└── _merged.json                   # Generated at boot (complete catalog)
```

### **Manifest Load Order**

```javascript
// At Safebox startup
const manifests = [
    '/opt/safebox/manifests/base.json',          // Always first
    ...discoverComponentManifests(),             // Auto-discover
];

const mergedManifest = manifests.reduce((acc, path) => {
    if (fs.existsSync(path)) {
        const manifest = JSON.parse(fs.readFileSync(path));
        return deepMerge(acc, manifest);
    }
    return acc;
}, {});

// Write merged manifest for quick access
fs.writeFileSync('/opt/safebox/manifests/_merged.json', 
    JSON.stringify(mergedManifest, null, 2));
```

---

## Manifest Schema

### **Base Structure**

Each manifest follows this schema:

```typescript
interface ComponentManifest {
    component: {
        name: string;              // Component label (e.g., "base", "media", "llm-small")
        version: string;           // Component version
        license: string[];         // Licenses used
        disk: string;              // Disk usage (e.g., "370 MB")
        idleRAM: string;           // Idle RAM usage (e.g., "<20 MB")
    };
    
    packages?: {                   // NPM packages provided
        [category: string]: {
            [packageName: string]: PackageInfo;
        };
    };
    
    systemTools?: {                // System binaries/tools provided
        [toolName: string]: ToolInfo;
    };
    
    runtimes?: {                   // AI/ML runtimes provided
        [runtimeName: string]: RuntimeInfo;
    };
    
    models?: {                     // AI/ML models provided
        [modelName: string]: ModelInfo;
    };
    
    capabilities?: {               // Safebox capabilities enabled
        [capabilityURI: string]: CapabilityInfo;
    };
    
    workflows?: {                  // Workflows provided
        [workflowURI: string]: WorkflowInfo;
    };
    
    dependencies?: string[];       // Other components required
}
```

---

## Component Manifests

### **1. BASE.JSON** (Always Present)

**Location:** `/opt/safebox/manifests/base.json`

This manifest includes ALL 50+ npm packages. Partial example shown (full version is 500+ lines):

```json
{
    "component": {
        "name": "base",
        "version": "1.0.0",
        "license": ["MIT", "Apache-2.0", "BSD-3", "ISC", "LGPL-2.1+ (dynamic)"],
        "disk": "8 GB",
        "idleRAM": "2 GB"
    },
    
    "description": "Core Safebox AMI with MariaDB, PHP, nginx, Docker, Node.js, ZFS, 50+ npm packages",
    
    "packages": {
        "document": {
            "docx": {
                "module": "docx",
                "version": "^8.5.0",
                "license": "MIT",
                "description": "Create Word documents with full formatting",
                "exports": ["Document", "Packer", "Paragraph", "TextRun", "Table", "TableRow", "TableCell"]
            },
            "officegen": {
                "module": "officegen",
                "version": "^0.6.5",
                "license": "MIT",
                "description": "Generate Office documents (stream-based)",
                "exports": ["default"]
            },
            "htmlDocxJs": {
                "module": "html-docx-js",
                "version": "^0.3.1",
                "license": "MIT",
                "description": "Convert HTML to DOCX",
                "exports": ["asBlob"]
            },
            "docxTemplates": {
                "module": "docx-templates",
                "version": "^4.11.3",
                "license": "MIT",
                "description": "Fill DOCX templates with data",
                "exports": ["createReport"]
            },
            "exceljs": {
                "module": "exceljs",
                "version": "^4.4.0",
                "license": "MIT",
                "description": "Create/edit Excel spreadsheets",
                "exports": ["Workbook"]
            },
            "xlsx": {
                "module": "xlsx",
                "version": "^0.18.5",
                "license": "Apache-2.0",
                "description": "Parse and write Excel files",
                "exports": ["read", "write", "utils"]
            },
            "xlsxPopulate": {
                "module": "xlsx-populate",
                "version": "^1.21.0",
                "license": "MIT",
                "description": "Modify existing Excel files",
                "exports": ["fromDataAsync", "fromFileAsync"]
            },
            "pptxgenjs": {
                "module": "pptxgenjs",
                "version": "^3.12.0",
                "license": "MIT",
                "description": "Create PowerPoint presentations",
                "exports": ["default"]
            }
        },
        "pdf": {
            "pdfkit": {
                "module": "pdfkit",
                "version": "^0.14.0",
                "license": "MIT",
                "description": "Create PDF documents",
                "exports": ["default"]
            },
            "pdfLib": {
                "module": "pdf-lib",
                "version": "^1.17.1",
                "license": "MIT",
                "description": "Create and modify PDF files",
                "exports": ["PDFDocument", "rgb", "degrees"]
            },
            "jspdf": {
                "module": "jspdf",
                "version": "^2.5.1",
                "license": "MIT",
                "description": "Generate PDF files in JavaScript",
                "exports": ["jsPDF"]
            },
            "htmlPdfNode": {
                "module": "html-pdf-node",
                "version": "^1.0.8",
                "license": "MIT",
                "description": "Convert HTML to PDF",
                "exports": ["generatePdf"]
            }
        },
        "image": {
            "sharp": {
                "module": "sharp",
                "version": "^0.33.2",
                "license": "Apache-2.0",
                "description": "High-performance image processing",
                "exports": ["default"]
            },
            "jimp": {
                "module": "jimp",
                "version": "^0.22.10",
                "license": "MIT",
                "description": "Image processing (pure JavaScript)",
                "exports": ["default", "read"]
            },
            "canvas": {
                "module": "canvas",
                "version": "^2.11.2",
                "license": "MIT",
                "description": "Server-side Canvas API",
                "exports": ["createCanvas", "loadImage"]
            },
            "qrcode": {
                "module": "qrcode",
                "version": "^1.5.3",
                "license": "MIT",
                "description": "Generate QR codes",
                "exports": ["toBuffer", "toDataURL"]
            },
            "svgCaptcha": {
                "module": "svg-captcha",
                "version": "^1.4.0",
                "license": "MIT",
                "description": "Generate SVG CAPTCHAs",
                "exports": ["create", "createMathExpr"]
            }
        },
        "charts": {
            "chartjs": {
                "module": "chartjs-node-canvas",
                "version": "^4.1.6",
                "license": "MIT",
                "description": "Server-side Chart.js rendering",
                "exports": ["ChartJSNodeCanvas"]
            },
            "mermaid": {
                "module": "mermaid",
                "version": "^10.9.0",
                "license": "MIT",
                "description": "Generate diagrams from text",
                "exports": ["default", "render"]
            },
            "d3Node": {
                "module": "d3-node",
                "version": "^3.0.0",
                "license": "MIT",
                "description": "Server-side D3.js",
                "exports": ["D3Node"]
            },
            "vega": {
                "module": "vega",
                "version": "^5.27.0",
                "license": "BSD-3-Clause",
                "description": "Declarative visualization grammar",
                "exports": ["View", "parse"]
            },
            "vegaLite": {
                "module": "vega-lite",
                "version": "^5.16.3",
                "license": "BSD-3-Clause",
                "description": "High-level visualization grammar",
                "exports": ["compile"]
            }
        },
        "archive": {
            "archiver": {
                "module": "archiver",
                "version": "^6.0.1",
                "license": "MIT",
                "description": "Create ZIP/TAR archives",
                "exports": ["default"]
            },
            "admZip": {
                "module": "adm-zip",
                "version": "^0.5.10",
                "license": "MIT",
                "description": "Simple ZIP manipulation",
                "exports": ["default"]
            },
            "tarStream": {
                "module": "tar-stream",
                "version": "^3.1.7",
                "license": "MIT",
                "description": "TAR stream parsing/creation",
                "exports": ["pack", "extract"]
            }
        },
        "email": {
            "nodemailer": {
                "module": "nodemailer",
                "version": "^6.9.9",
                "license": "MIT",
                "description": "Send emails",
                "exports": ["createTransport"]
            },
            "mjml": {
                "module": "mjml",
                "version": "^4.15.3",
                "license": "MIT",
                "description": "Responsive email markup",
                "exports": ["default"]
            }
        },
        "markdown": {
            "markdownIt": {
                "module": "markdown-it",
                "version": "^14.0.0",
                "license": "MIT",
                "description": "Markdown parser",
                "exports": ["default"]
            },
            "marked": {
                "module": "marked",
                "version": "^12.0.0",
                "license": "MIT",
                "description": "Fast Markdown parser",
                "exports": ["marked", "parse"]
            },
            "turndown": {
                "module": "turndown",
                "version": "^7.1.2",
                "license": "MIT",
                "description": "HTML to Markdown converter",
                "exports": ["default"]
            },
            "slate": {
                "module": "slate",
                "version": "^0.103.0",
                "license": "MIT",
                "description": "Rich text editor framework",
                "exports": ["createEditor", "Transforms"]
            }
        },
        "data": {
            "papaparse": {
                "module": "papaparse",
                "version": "^5.4.1",
                "license": "MIT",
                "description": "CSV parser/writer",
                "exports": ["parse", "unparse"]
            },
            "json2csv": {
                "module": "json2csv",
                "version": "^6.0.0",
                "license": "MIT",
                "description": "JSON to CSV converter",
                "exports": ["parse", "Parser"]
            },
            "xml2js": {
                "module": "xml2js",
                "version": "^0.6.2",
                "license": "MIT",
                "description": "XML to JavaScript object converter",
                "exports": ["parseString", "Builder"]
            },
            "fastXmlParser": {
                "module": "fast-xml-parser",
                "version": "^4.3.5",
                "license": "MIT",
                "description": "Fast XML parser/builder",
                "exports": ["XMLParser", "XMLBuilder"]
            },
            "yaml": {
                "module": "yaml",
                "version": "^2.3.4",
                "license": "ISC",
                "description": "YAML parser/stringifier",
                "exports": ["parse", "stringify"]
            },
            "toml": {
                "module": "toml",
                "version": "^3.0.0",
                "license": "MIT",
                "description": "TOML parser",
                "exports": ["parse"]
            }
        },
        "template": {
            "handlebars": {
                "module": "handlebars",
                "version": "^4.7.8",
                "license": "MIT",
                "description": "Handlebars template engine",
                "exports": ["compile", "registerHelper"]
            },
            "mustache": {
                "module": "mustache",
                "version": "^4.2.0",
                "license": "MIT",
                "description": "Mustache template engine",
                "exports": ["render", "parse"]
            },
            "ejs": {
                "module": "ejs",
                "version": "^3.1.9",
                "license": "Apache-2.0",
                "description": "Embedded JavaScript templates",
                "exports": ["render", "compile"]
            },
            "pug": {
                "module": "pug",
                "version": "^3.0.2",
                "license": "MIT",
                "description": "Pug template engine",
                "exports": ["render", "compile"]
            }
        },
        "barcode": {
            "jsbarcode": {
                "module": "jsbarcode",
                "version": "^3.11.6",
                "license": "MIT",
                "description": "Barcode generator",
                "exports": ["default"]
            },
            "bwipJs": {
                "module": "bwip-js",
                "version": "^4.3.0",
                "license": "MIT",
                "description": "Advanced barcode generator (100+ formats)",
                "exports": ["toBuffer", "toSVG"]
            }
        },
        "font": {
            "opentype": {
                "module": "opentype.js",
                "version": "^1.3.4",
                "license": "MIT",
                "description": "Parse and write OpenType fonts",
                "exports": ["load", "parse"]
            }
        },
        "encoding": {
            "textEncoding": {
                "module": "text-encoding",
                "version": "^0.7.0",
                "license": "Apache-2.0",
                "description": "TextEncoder/TextDecoder polyfill",
                "exports": ["TextEncoder", "TextDecoder"]
            },
            "iconvLite": {
                "module": "iconv-lite",
                "version": "^0.6.3",
                "license": "MIT",
                "description": "Character encoding conversion",
                "exports": ["decode", "encode"]
            },
            "stringWidth": {
                "module": "string-width",
                "version": "^7.1.0",
                "license": "MIT",
                "description": "Get visual width of string",
                "exports": ["default"]
            }
        },
        "utility": {
            "lodash": {
                "module": "lodash",
                "version": "^4.17.21",
                "license": "MIT",
                "description": "Utility library",
                "exports": ["default"]
            },
            "moment": {
                "module": "moment",
                "version": "^2.30.1",
                "license": "MIT",
                "description": "Date/time manipulation",
                "exports": ["default"]
            },
            "dayjs": {
                "module": "dayjs",
                "version": "^1.11.10",
                "license": "MIT",
                "description": "Lightweight date library",
                "exports": ["default"]
            },
            "uuid": {
                "module": "uuid",
                "version": "^9.0.1",
                "license": "MIT",
                "description": "UUID generator",
                "exports": ["v4", "v1", "v5"]
            },
            "nanoid": {
                "module": "nanoid",
                "version": "^5.0.5",
                "license": "MIT",
                "description": "Tiny URL-friendly ID generator",
                "exports": ["nanoid"]
            }
        },
        "officeParser": {
            "mammoth": {
                "module": "mammoth",
                "version": "^1.6.0",
                "license": "BSD-2-Clause",
                "description": "Extract text from DOCX files",
                "exports": ["extractRawText", "convertToHtml"]
            }
        }
    },
    
    "systemTools": {
        "mariadb": {
            "binary": "/usr/bin/mysql",
            "version": "10.5",
            "description": "MariaDB database server"
        },
        "php": {
            "binary": "/usr/bin/php",
            "version": "8.2",
            "description": "PHP runtime"
        },
        "nginx": {
            "binary": "/usr/sbin/nginx",
            "version": "1.24",
            "description": "Web server"
        },
        "docker": {
            "binary": "/usr/bin/docker",
            "version": "24.0",
            "description": "Container runtime"
        },
        "node": {
            "binary": "/usr/bin/node",
            "version": "18",
            "description": "Node.js runtime"
        },
        "zfs": {
            "binary": "/usr/sbin/zfs",
            "version": "2.2",
            "description": "ZFS filesystem"
        }
    },
    
    "capabilities": {
        "Safebox/capability/database/query": {
            "provider": "com.safebox.local",
            "runtime": "mariadb",
            "description": "Execute SQL queries"
        },
        "Safebox/capability/storage/store": {
            "provider": "com.safebox.local",
            "runtime": "zfs",
            "description": "Store files with encryption"
        }
    },
    
    "sandboxGlobals": [
        "docx", "officegen", "htmlDocxJs", "docxTemplates",
        "exceljs", "xlsx", "xlsxPopulate",
        "pptxgenjs",
        "pdfkit", "pdfLib", "jspdf", "htmlPdfNode",
        "sharp", "jimp", "canvas", "qrcode", "svgCaptcha",
        "chartjs", "mermaid", "d3Node", "vega", "vegaLite",
        "archiver", "admZip", "tarStream",
        "nodemailer", "mjml",
        "markdownIt", "marked", "turndown", "slate",
        "papaparse", "json2csv", "xml2js", "fastXmlParser", "yaml", "toml",
        "handlebars", "mustache", "ejs", "pug",
        "jsbarcode", "bwipJs",
        "opentype",
        "textEncoding", "iconvLite", "stringWidth",
        "lodash", "_", "moment", "dayjs", "uuid", "nanoid",
        "mammoth"
    ]
}
```

**Note:** Full `base.json` is ~500 lines. This includes ALL 50+ npm packages from the catalog.

---

### **2. MEDIA.JSON** (Optional Component)

```json
{
    "component": {
        "name": "media",
        "version": "1.0.0",
        "license": ["LGPL-2.1+ (dynamic)", "BSD-3", "MIT"],
        "disk": "370 MB",
        "idleRAM": "<20 MB"
    },
    
    "description": "Media processing toolchain (FFmpeg, pdfium, libvips) - GPL-free",
    
    "systemTools": {
        "FFmpeg": {
            "module": "@safebox/ffmpeg",
            "binary": "/opt/safebox/media/bin/ffmpeg",
            "version": "6.1",
            "license": "LGPL-2.1+",
            "description": "Audio/video processing (LGPL build, no GPL codecs)",
            "exports": ["FFmpeg", "FFmpegError"],
            "methods": ["probe", "extractAudio", "extractVideo", "transcode", "extractFrames"]
        },
        "PDFium": {
            "module": "@safebox/pdfium",
            "binary": "/opt/safebox/media/bin/pdfium",
            "version": "6000",
            "license": "BSD-3",
            "description": "PDF rendering and text extraction",
            "exports": ["PDFium", "PDFiumError"],
            "methods": ["render", "extractText", "getMetadata", "measureTextDensity"]
        },
        "libvips": {
            "module": "@safebox/vips",
            "binary": "/opt/safebox/media/bin/vips",
            "version": "8.15",
            "license": "LGPL-2.1+",
            "description": "Fast image processing",
            "exports": ["Vips", "VipsError"],
            "methods": ["resize", "crop", "convert", "composite"]
        },
        "ImageMagick": {
            "module": "@safebox/imagemagick",
            "binary": "/opt/safebox/media/bin/convert",
            "version": "7.1",
            "license": "Apache-style",
            "description": "Image format conversion",
            "exports": ["ImageMagick", "ImageMagickError"],
            "methods": ["convert", "resize", "crop", "rotate"]
        }
    },
    
    "capabilities": {
        "Safebox/capability/media/transcode": {
            "provider": "com.safebox.local",
            "runtime": "ffmpeg",
            "description": "Transcode audio/video files",
            "safebuxCost": 50,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/media/extract-frames": {
            "provider": "com.safebox.local",
            "runtime": "ffmpeg",
            "description": "Extract video frames",
            "safebuxCost": 30,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/document/render": {
            "provider": "com.safebox.local",
            "runtime": "pdfium",
            "description": "Render PDF pages to images",
            "safebuxCost": 10,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/image/convert": {
            "provider": "com.safebox.local",
            "runtime": "imagemagick",
            "description": "Convert image formats",
            "safebuxCost": 5,
            "cacheHitDiscount": 0.5
        }
    },
    
    "workflows": {
        "Safebox/workflow/ingest-video": {
            "provider": "com.safebox.local",
            "description": "Complete video ingestion pipeline",
            "steps": ["probe", "scene-detect", "extract-keyframes", "visual-embed", "transcribe"]
        },
        "Safebox/workflow/ingest-document": {
            "provider": "com.safebox.local",
            "description": "Complete document ingestion pipeline",
            "steps": ["render", "extract-text", "measure-density", "embed-text", "visual-embed"]
        }
    },
    
    "sandboxGlobals": [
        "FFmpeg", "PDFium", "ImageMagick", "Vips", "Media"
    ],
    
    "dependencies": []
}
```

---

### **3. LIBREOFFICE.JSON** (Optional Component)

```json
{
    "component": {
        "name": "libreoffice",
        "version": "1.0.0",
        "license": ["MPL-2.0"],
        "disk": "600 MB",
        "idleRAM": "~150 MB (when active)"
    },
    
    "description": "LibreOffice headless for Office document conversion",
    
    "systemTools": {
        "LibreOffice": {
            "module": "@safebox/libreoffice",
            "binary": "/opt/safebox/libreoffice/program/soffice",
            "version": "7.6",
            "license": "MPL-2.0",
            "description": "Office document conversion",
            "exports": ["LibreOffice", "LibreOfficeError"],
            "methods": ["toPDF", "extractText"]
        }
    },
    
    "capabilities": {
        "Safebox/capability/document/office-to-pdf": {
            "provider": "com.safebox.local",
            "runtime": "libreoffice",
            "description": "Convert Office documents to PDF",
            "safebuxCost": 20,
            "cacheHitDiscount": 0.5
        }
    },
    
    "sandboxGlobals": [
        "LibreOffice"
    ],
    
    "dependencies": ["media"]
}
```

---

### **4. VISION.JSON** (Optional Component)

```json
{
    "component": {
        "name": "vision",
        "version": "1.0.0",
        "license": ["Apache-2.0", "MIT"],
        "disk": "1.5 GB",
        "activeRAM": "~2 GB"
    },
    
    "description": "Vision capabilities: SigLIP, BiRefNet, SAM 2",
    
    "runtimes": {
        "onnxruntime": {
            "path": "/opt/safebox/vision/runtimes/onnxruntime",
            "version": "1.17.0",
            "license": "MIT",
            "executionProviders": ["CPUExecutionProvider"]
        }
    },
    
    "models": {
        "siglip-base-patch16-256": {
            "path": "/opt/safebox/vision/models/siglip-base-patch16-256/model.onnx",
            "format": "onnx",
            "license": "Apache-2.0",
            "disk": "600 MB",
            "activeRAM": "1 GB",
            "hash": "sha256:a1b2c3d4e5f6..."
        },
        "birefnet-lite": {
            "path": "/opt/safebox/vision/models/birefnet-lite/model.onnx",
            "format": "onnx",
            "license": "MIT",
            "disk": "180 MB",
            "activeRAM": "1.5 GB",
            "hash": "sha256:f1e2d3c4b5a6..."
        },
        "sam2-base": {
            "path": "/opt/safebox/vision/models/sam2-base/model.onnx",
            "format": "onnx",
            "license": "Apache-2.0",
            "disk": "400 MB",
            "activeRAM": "2 GB",
            "hash": "sha256:1a2b3c4d5e6f..."
        }
    },
    
    "capabilities": {
        "Safebox/capability/vision/embed": {
            "provider": "com.safebox.local",
            "runtime": "onnxruntime",
            "model": "siglip-base-patch16-256",
            "description": "Image embeddings (512-dim, int8-quantized)",
            "eager": true,
            "writes": ["Safebox/visualEmbedding", "Safebox/visualTags"],
            "safebuxCost": 5,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/vision/matte": {
            "provider": "com.safebox.local",
            "runtime": "onnxruntime",
            "model": "birefnet-lite",
            "description": "Background matting/removal",
            "eager": false,
            "safebuxCost": 15,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/vision/segment": {
            "provider": "com.safebox.local",
            "runtime": "onnxruntime",
            "model": "sam2-base",
            "description": "Object segmentation",
            "eager": false,
            "safebuxCost": 20,
            "cacheHitDiscount": 0.5
        }
    },
    
    "sandboxGlobals": [
        "Vision"
    ],
    
    "dependencies": []
}
```

---

### **5. LLM-SMALL.JSON** (Optional Component)

```json
{
    "component": {
        "name": "llm-small",
        "version": "1.0.0",
        "license": ["Apache-2.0", "MIT", "Gemma Terms"],
        "disk": "25.5 GB",
        "activeRAM": "~12 GB"
    },
    
    "description": "Small LLMs: Qwen 8B, Mistral 12B, Phi-4 14B, Gemma 9B",
    
    "runtimes": {
        "llama.cpp": {
            "path": "/opt/safebox/llm-small/runtimes/llama.cpp",
            "version": "b3751",
            "license": "MIT",
            "binaries": ["llama-server", "llama-cli"]
        }
    },
    
    "models": {
        "qwen-3.6-8b-instruct-q4": {
            "path": "/opt/safebox/llm-small/models/qwen-3.6-8b-instruct-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "5 GB",
            "activeRAM": "7 GB",
            "contextLength": 32768,
            "hash": "sha256:abc123..."
        },
        "mistral-nemo-12b-instruct-q4": {
            "path": "/opt/safebox/llm-small/models/mistral-nemo-12b-instruct-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Apache-2.0",
            "disk": "7 GB",
            "activeRAM": "9 GB",
            "contextLength": 16384,
            "hash": "sha256:def456..."
        },
        "phi-4-14b-q4": {
            "path": "/opt/safebox/llm-small/models/phi-4-14b-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "MIT",
            "disk": "8 GB",
            "activeRAM": "10 GB",
            "contextLength": 16384,
            "hash": "sha256:ghi789..."
        },
        "gemma-4-9b-instruct-q4": {
            "path": "/opt/safebox/llm-small/models/gemma-4-9b-instruct-q4_k_m.gguf",
            "format": "gguf",
            "quantization": "Q4_K_M",
            "license": "Gemma Terms",
            "disk": "5.5 GB",
            "activeRAM": "7 GB",
            "contextLength": 8192,
            "hash": "sha256:jkl012..."
        }
    },
    
    "capabilities": {
        "Safebox/capability/llm/chat": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "models": ["qwen-3.6-8b-instruct-q4", "mistral-nemo-12b-instruct-q4", "phi-4-14b-q4", "gemma-4-9b-instruct-q4"],
            "description": "Conversational AI",
            "deterministic": true,
            "seedSupport": true,
            "safebuxCost": 100,
            "cacheHitDiscount": 0.5
        },
        "Safebox/capability/llm/complete": {
            "provider": "com.safebox.local",
            "runtime": "llama.cpp",
            "models": ["qwen-3.6-8b-instruct-q4", "mistral-nemo-12b-instruct-q4"],
            "description": "Text completion",
            "safebuxCost": 80,
            "cacheHitDiscount": 0.5
        }
    },
    
    "systemd": {
        "units": [
            "llama-server@qwen-8b.service",
            "llama-server@mistral-12b.service",
            "llama-server@phi-4-14b.service",
            "llama-server@gemma-9b.service"
        ]
    },
    
    "sandboxGlobals": [
        "LLM"
    ],
    
    "dependencies": []
}
```

---

## Manifest Merging Logic

### **Deep Merge Strategy**

```javascript
function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] instanceof Object && key in target) {
            // Recurse for nested objects
            Object.assign(source[key], deepMerge(target[key], source[key]));
        }
    }
    
    // Arrays: concatenate and deduplicate
    if (Array.isArray(target) && Array.isArray(source)) {
        return [...new Set([...target, ...source])];
    }
    
    // Merge objects
    Object.assign(target || {}, source);
    return target;
}
```

### **Example: Base + Media + Vision**

**Input:**
- `base.json`: Provides docx, sharp, lodash
- `media.json`: Provides FFmpeg, PDFium
- `vision.json`: Provides Vision capability

**Output (`_merged.json`):**
```json
{
    "components": ["base", "media", "vision"],
    "packages": {
        "document": { "docx": {...} },
        "image": { "sharp": {...} },
        "utility": { "lodash": {...} }
    },
    "systemTools": {
        "FFmpeg": {...},
        "PDFium": {...}
    },
    "runtimes": {
        "onnxruntime": {...}
    },
    "models": {
        "siglip-base-patch16-256": {...}
    },
    "capabilities": {
        "Safebox/capability/media/transcode": {...},
        "Safebox/capability/vision/embed": {...}
    },
    "sandboxGlobals": [
        "docx", "sharp", "lodash", 
        "FFmpeg", "PDFium", 
        "Vision"
    ]
}
```

---

## Sandbox Integration

### **Loading at Startup**

```javascript
// /opt/safebox/lib/sandbox/loader.js

const fs = require('fs');
const path = require('path');

const MANIFEST_DIR = '/opt/safebox/manifests';
const MERGED_MANIFEST_PATH = path.join(MANIFEST_DIR, '_merged.json');

function loadManifests() {
    // Check if merged manifest exists and is recent
    if (fs.existsSync(MERGED_MANIFEST_PATH)) {
        const stats = fs.statSync(MERGED_MANIFEST_PATH);
        const age = Date.now() - stats.mtimeMs;
        
        // Use cached if less than 1 hour old
        if (age < 3600000) {
            return JSON.parse(fs.readFileSync(MERGED_MANIFEST_PATH));
        }
    }
    
    // Build merged manifest
    const manifests = [];
    
    // Always load base first
    manifests.push(loadManifest('base.json'));
    
    // Auto-discover component manifests
    const files = fs.readdirSync(MANIFEST_DIR);
    for (const file of files) {
        if (file !== 'base.json' && 
            file !== '_merged.json' && 
            file.endsWith('.json')) {
            manifests.push(loadManifest(file));
        }
    }
    
    // Merge all manifests
    const merged = manifests.reduce(deepMerge, {
        components: [],
        packages: {},
        systemTools: {},
        runtimes: {},
        models: {},
        capabilities: {},
        workflows: {},
        sandboxGlobals: []
    });
    
    // Write merged manifest
    fs.writeFileSync(MERGED_MANIFEST_PATH, 
        JSON.stringify(merged, null, 2));
    
    return merged;
}

function loadManifest(filename) {
    const filepath = path.join(MANIFEST_DIR, filename);
    if (!fs.existsSync(filepath)) {
        return {};
    }
    
    const manifest = JSON.parse(fs.readFileSync(filepath));
    
    // Track which component this is from
    if (manifest.component) {
        manifest.components = [manifest.component.name];
    }
    
    return manifest;
}

module.exports = { loadManifests };
```

### **Building Sandbox Globals**

```javascript
// /opt/safebox/lib/sandbox/globals.js

function buildSandboxGlobals(manifest) {
    const globals = {};
    
    // Load npm packages
    for (const category of Object.values(manifest.packages || {})) {
        for (const [name, info] of Object.entries(category)) {
            try {
                globals[name] = require(info.module);
            } catch (err) {
                console.warn(`Failed to load ${name}: ${err.message}`);
            }
        }
    }
    
    // Load system tools
    for (const [name, info] of Object.entries(manifest.systemTools || {})) {
        if (info.module) {
            try {
                const module = require(info.module);
                globals[name] = module[name] || module.default || module;
            } catch (err) {
                console.warn(`Failed to load ${name}: ${err.message}`);
            }
        }
    }
    
    // Add utility shortcuts
    if (globals.lodash) {
        globals._ = globals.lodash;
    }
    
    return globals;
}

module.exports = { buildSandboxGlobals };
```

---

## Component Installation

### **Manifest Generation During Build**

```bash
#!/bin/bash
# /opt/safebox-build/components/media/install-media.sh

set -euo pipefail

echo "Installing media component..."

# Install FFmpeg, pdfium, etc.
./build-ffmpeg.sh
./install-pdfium.sh
# ...

# Generate manifest
cat > /opt/safebox/manifests/media.json << 'EOF'
{
    "component": {
        "name": "media",
        "version": "1.0.0",
        "license": ["LGPL-2.1+", "BSD-3", "MIT"],
        "disk": "370 MB",
        "idleRAM": "<20 MB"
    },
    "systemTools": {
        "FFmpeg": {
            "module": "@safebox/ffmpeg",
            "binary": "/opt/safebox/media/bin/ffmpeg",
            ...
        }
    },
    ...
}
EOF

echo "Media component installed"
```

---

## Summary

**Cascading manifest system:**
1. ✅ Each component provides `/opt/safebox/manifests/{component}.json`
2. ✅ `base.json` always present (core packages + tools)
3. ✅ Component manifests auto-discovered at startup
4. ✅ Deep merge creates `_merged.json` (complete catalog)
5. ✅ Sandbox loads merged manifest → builds globals
6. ✅ No require() needed in sandbox code

**Benefits:**
- ✅ Clean separation (each component self-describes)
- ✅ Automatic capability discovery
- ✅ Type-safe (JSON schema)
- ✅ Fast startup (merged manifest cached)
- ✅ Easy debugging (inspect `_merged.json`)

**Ready for composable AMI architecture!** 🚀
