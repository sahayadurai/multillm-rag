"""Multi-file processor - supports PDF, DOCX, TXT, and more."""
from __future__ import annotations
import io, hashlib, re
from pathlib import Path
from typing import Optional

try:
    import pdfplumber
    from pypdf import PdfReader
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False

try:
    from docx import Document
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False


def _clean(text: str) -> str:
    """Clean and normalize text."""
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def extract_text_chunks(file_path: str | Path, chunk_size: int = 512,
                        overlap: int = 64) -> list[dict]:
    """Extract text chunks from any supported file type."""
    path = Path(file_path)
    file_ext = path.suffix.lower()
    
    if file_ext == '.pdf' and PDF_AVAILABLE:
        return _extract_pdf_text(path, chunk_size, overlap)
    elif file_ext == '.docx' and DOCX_AVAILABLE:
        return _extract_docx_text(path, chunk_size, overlap)
    elif file_ext in ['.txt', '.md', '.text']:
        return _extract_text_file(path, chunk_size, overlap)
    else:
        # Fallback: try to read as plain text
        return _extract_text_file(path, chunk_size, overlap)


def _extract_pdf_text(pdf_path: Path, chunk_size: int, overlap: int) -> list[dict]:
    """Extract text chunks from PDF."""
    if not PDF_AVAILABLE:
        return []
    
    chunks = []
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                raw = page.extract_text() or ""
                raw = _clean(raw)
                if not raw:
                    continue
                
                words = raw.split()
                start = 0
                cidx = 0
                while start < len(words):
                    end = min(start + chunk_size, len(words))
                    chunk_text = " ".join(words[start:end])
                    chunks.append({
                        "text": chunk_text,
                        "page": page_num,
                        "chunk_idx": cidx,
                        "source": pdf_path.name,
                        "type": "text",
                    })
                    cidx += 1
                    start += chunk_size - overlap
    except Exception as e:
        print(f"Error extracting PDF: {e}")
    
    return chunks


def _extract_docx_text(docx_path: Path, chunk_size: int, overlap: int) -> list[dict]:
    """Extract text chunks from DOCX."""
    if not DOCX_AVAILABLE:
        return []
    
    chunks = []
    try:
        doc = Document(str(docx_path))
        full_text = ""
        
        for para in doc.paragraphs:
            if para.text.strip():
                full_text += para.text + "\n"
        
        full_text = _clean(full_text)
        if not full_text:
            return []
        
        words = full_text.split()
        start = 0
        cidx = 0
        page = 1
        
        while start < len(words):
            end = min(start + chunk_size, len(words))
            chunk_text = " ".join(words[start:end])
            chunks.append({
                "text": chunk_text,
                "page": page,
                "chunk_idx": cidx,
                "source": docx_path.name,
                "type": "text",
            })
            cidx += 1
            start += chunk_size - overlap
    except Exception as e:
        print(f"Error extracting DOCX: {e}")
    
    return chunks


def _extract_text_file(text_path: Path, chunk_size: int, overlap: int) -> list[dict]:
    """Extract text chunks from plain text files."""
    chunks = []
    try:
        with open(text_path, 'r', encoding='utf-8', errors='ignore') as f:
            full_text = f.read()
        
        full_text = _clean(full_text)
        if not full_text:
            return []
        
        words = full_text.split()
        start = 0
        cidx = 0
        page = 1
        
        while start < len(words):
            end = min(start + chunk_size, len(words))
            chunk_text = " ".join(words[start:end])
            chunks.append({
                "text": chunk_text,
                "page": page,
                "chunk_idx": cidx,
                "source": text_path.name,
                "type": "text",
            })
            cidx += 1
            start += chunk_size - overlap
    except Exception as e:
        print(f"Error extracting text file: {e}")
    
    return chunks


def extract_images(file_path: str | Path) -> list[dict]:
    """Extract images from file (PDF only for now)."""
    path = Path(file_path)
    file_ext = path.suffix.lower()
    
    if file_ext == '.pdf' and PDF_AVAILABLE:
        return _extract_pdf_images(path)
    
    return []


def _extract_pdf_images(pdf_path: Path) -> list[dict]:
    """Extract images from PDF pages and OCR any embedded text."""
    if not PDF_AVAILABLE:
        return []

    try:
        import pytesseract
        _has_ocr = True
    except ImportError:
        _has_ocr = False

    images_meta = []
    try:
        reader = PdfReader(str(pdf_path))
        for page_num, page in enumerate(reader.pages, 1):
            try:
                for img_file in page.images:          # pypdf 5.x high-level API
                    try:
                        pil_img = img_file.image      # PIL Image object
                        w, h = pil_img.size
                        img_hash = hashlib.md5(img_file.data[:1024]).hexdigest()[:12]

                        ocr_text = ""
                        if _has_ocr:
                            try:
                                ocr_text = pytesseract.image_to_string(pil_img).strip()
                            except Exception:
                                pass

                        chunk_text = (
                            f"Image on page {page_num} ({w}x{h}): {ocr_text}"
                            if ocr_text
                            else f"[Image on page {page_num}, {w}x{h}]"
                        )
                        images_meta.append({
                            "page": page_num,
                            "width": w,
                            "height": h,
                            "hash": img_hash,
                            "source": pdf_path.name,
                            "type": "image",
                            "text": chunk_text,
                        })
                    except Exception:
                        continue
            except Exception:
                continue
    except Exception as e:
        print(f"Error extracting images: {e}")

    return images_meta


def extract_tables(file_path: str | Path) -> list[dict]:
    """Extract tables (PDF only for now)."""
    path = Path(file_path)
    file_ext = path.suffix.lower()
    
    if file_ext == '.pdf' and PDF_AVAILABLE:
        return _extract_pdf_tables(path)
    
    return []


def _extract_pdf_tables(pdf_path: Path) -> list[dict]:
    """Extract tables from PDF."""
    if not PDF_AVAILABLE:
        return []
    
    tables_data = []
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                tables = page.extract_tables()
                for tidx, table in enumerate(tables):
                    if not table:
                        continue
                    rows = []
                    for row in table:
                        cells = [str(c).strip() if c else "" for c in row]
                        rows.append(" | ".join(cells))
                    table_text = "\n".join(rows)
                    tables_data.append({
                        "text": table_text,
                        "page": page_num,
                        "chunk_idx": tidx,
                        "source": pdf_path.name,
                        "type": "table",
                    })
    except Exception as e:
        print(f"Error extracting tables: {e}")
    
    return tables_data
