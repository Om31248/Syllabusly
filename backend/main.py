"""
Syllabusly backend - main.py

Handles syllabus uploads, pulls text out of the PDF, and asks Gemini to
turn that into a clean list of assignments/exams/etc. we can hand back
to the frontend.

Env vars needed (see .env):
    GEMINI_API_KEY - Google Generative AI key

Run with:
    uvicorn main:app --reload --port 8000
"""

import os
import io
import json
import uuid
import logging
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import pypdf
import google.generativeai as genai

load_dotenv()

# ---------------------------------------------------------------------------
# basic setup
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("syllabusly")

app = FastAPI(title="Syllabusly API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
else:
    # Don't crash the whole app over this - let the server boot so other
    # routes still work, and just fail this one endpoint loudly with a
    # useful message instead of a stack trace.
    logger.warning("GEMINI_API_KEY is not set - /api/upload-syllabus will fail until it is.")

VALID_TYPES = {"Exam", "Assignment", "Quiz", "Project"}
VALID_PRIORITIES = {"High", "Medium", "Low"}

DEFAULT_YEAR = 2026


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Pull all the text we can out of a PDF. Raises ValueError if there's
    basically nothing usable in there (scanned image syllabus, etc.)."""
    reader = pypdf.PdfReader(io.BytesIO(file_bytes))

    if len(reader.pages) == 0:
        raise ValueError("PDF has no pages")

    pages_text = []
    for page in reader.pages:
        page_text = page.extract_text() or ""
        pages_text.append(page_text)

    full_text = "\n".join(pages_text).strip()

    # A PDF with no extractable text is almost always a scanned image with
    # no OCR layer - pypdf can't do anything with that.
    if len(full_text) < 40:
        raise ValueError("Could not extract meaningful text from PDF (likely scanned/image-based)")

    return full_text


def build_prompt(syllabus_text: str) -> str:
    # Truncate defensively - some syllabi have huge appendices we don't need
    # and it just burns tokens for no benefit.
    trimmed = syllabus_text[:15000]

    return f"""You are an assistant that extracts graded course deliverables from a
university course syllabus. Read the syllabus text below and identify every
assignment, quiz, midterm, project, and final exam that has a weight and/or
due date associated with it.

Do not assume any particular course - determine the course code directly
from whatever appears in the document itself (e.g. "CS135", "ECON101",
"MATH128", "HIST201"). Different syllabi will have entirely different
course codes and you must extract whatever is actually present, not a
fixed or example value.

Return ONLY a valid JSON array. No markdown formatting, no code fences, no
commentary before or after it - just the raw JSON array, because it will be
parsed directly with json.loads().

Each object in the array must have exactly these fields:
- "course_code": string, extracted from the syllabus header/title. Infer it
  from context if it isn't repeated near each item, but never invent a
  code that doesn't appear in the document.
- "title": string, short descriptive name, e.g. "Midterm Exam 1" or
  "Case Study Analysis"
- "due_date": string in YYYY-MM-DD format. If the syllabus gives a date
  without a year, assume {DEFAULT_YEAR}. If a date genuinely cannot be
  determined at all, use "TBD".
- "type": one of "Exam", "Assignment", "Quiz", "Project"
- "weight": integer percentage of the final grade, e.g. 20. If not stated,
  make a reasonable estimate of 0.
- "priority": one of "High", "Medium", "Low" based on weight -
  above 15% is High, 5% to 15% is Medium, below 5% is Low
- "estimated_hours": integer, a reasonable estimate of hours a student would
  need to prepare for or complete this item, based on its type and weight

Do not include lecture readings, participation marks with no fixed date, or
anything that isn't a discrete gradeable item.

Syllabus text:
---
{trimmed}
---
"""


def call_gemini(prompt: str) -> str:
    """Ask Gemini to do the extraction.

    We tell it explicitly to respond with application/json - this is the
    actual fix for the "model wraps everything in ```json fences" problem,
    instead of trying to regex/strip our way around it after the fact.
    Much more reliable and it saves us a chunk of cleanup code too.
    """
    model = genai.GenerativeModel(
        MODEL_NAME,
        generation_config={
            "response_mime_type": "application/json",
            "temperature": 0.2,  # keep it consistent, this isn't a creative task
        },
    )
    response = model.generate_content(prompt)
    return response.text


def clean_json_response(raw_text: str) -> list:
    """Even with response_mime_type set, be defensive - older SDK versions
    or edge cases can still hand back stray whitespace/fences, so we just
    grab the outermost [ ... ] before handing it to json.loads."""
    text = raw_text.strip().strip("`")

    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON array found in model response")

    parsed = json.loads(text[start:end + 1])

    if not isinstance(parsed, list):
        raise ValueError("Model response was not a JSON array")

    return parsed


def safe_int(value, default: int = 0) -> int:
    """Little helper so we're not repeating the same try/except everywhere -
    Gemini occasionally hands back "20%" or "20.0" instead of a clean int."""
    try:
        return int(float(str(value).strip().rstrip("%")))
    except (TypeError, ValueError):
        return default


def derive_priority(weight: int) -> str:
    if weight > 15:
        return "High"
    if weight >= 5:
        return "Medium"
    return "Low"


def normalize_due_date(raw_date) -> str:
    """Coerce whatever Gemini gives us into YYYY-MM-DD or "TBD". Handles the
    common case of a year-less date (e.g. "03-15") by assuming DEFAULT_YEAR,
    since we ask for that in the prompt but the model doesn't always comply."""
    if not raw_date or raw_date == "TBD":
        return "TBD"

    raw_date = str(raw_date).strip()

    try:
        datetime.strptime(raw_date, "%Y-%m-%d")
        return raw_date
    except ValueError:
        pass

    try:
        parsed = datetime.strptime(raw_date, "%m-%d")
        return parsed.replace(year=DEFAULT_YEAR).strftime("%Y-%m-%d")
    except ValueError:
        pass

    return "TBD"


def normalize_item(item: dict) -> dict:
    """Fill in gaps / coerce types so the frontend never chokes on a
    malformed item coming back from the model. This is our real safety
    net - even if Gemini gets a field wrong or skips one, everything
    that leaves this function is guaranteed to match the shape the
    frontend expects."""
    weight = safe_int(item.get("weight"), default=0)
    estimated_hours = safe_int(item.get("estimated_hours"), default=0)

    item_type = item.get("type")
    if item_type not in VALID_TYPES:
        item_type = "Assignment"

    priority = item.get("priority")
    if priority not in VALID_PRIORITIES:
        priority = derive_priority(weight)

    due_date = normalize_due_date(item.get("due_date"))

    return {
        "id": str(uuid.uuid4()),
        "course_code": item.get("course_code") or "UNKNOWN",
        "title": item.get("title") or "Untitled item",
        "due_date": due_date,
        "type": item_type,
        "weight": weight,
        "priority": priority,
        "estimated_hours": estimated_hours,
    }


def fallback_response(reason: str) -> dict:
    return {
        "success": False,
        "error": reason,
        "items": [],
    }


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    return {"status": "ok", "service": "syllabusly-api"}


@app.post("/api/upload-syllabus")
async def upload_syllabus(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported right now.")

    if not GEMINI_API_KEY:
        return fallback_response("Server is missing GEMINI_API_KEY - contact the administrator.")

    try:
        file_bytes = await file.read()
    except Exception:
        logger.exception("Failed to read uploaded file")
        return fallback_response("Could not read the uploaded file.")

    # Step 1: pull text out of the PDF
    try:
        syllabus_text = extract_text_from_pdf(file_bytes)
    except ValueError as e:
        logger.warning(f"PDF extraction issue for {file.filename}: {e}")
        return fallback_response(str(e))
    except Exception:
        logger.exception(f"Unexpected error extracting text from {file.filename}")
        return fallback_response("Unexpected error while reading the PDF.")

    # Step 2 + 3: send to Gemini and get structured JSON back
    try:
        prompt = build_prompt(syllabus_text)
        raw_response = call_gemini(prompt)
        parsed_items = clean_json_response(raw_response)
    except json.JSONDecodeError:
        logger.exception("Gemini response was not valid JSON")
        return fallback_response("The AI response could not be parsed. Please try again.")
    except Exception:
        logger.exception("Gemini extraction failed")
        return fallback_response("AI extraction failed. Please try again in a moment.")

    # Step 4: normalize + validate each item before handing it back
    try:
        cleaned_items = [normalize_item(item) for item in parsed_items if isinstance(item, dict)]
    except Exception:
        logger.exception("Failed to normalize extracted items")
        return fallback_response("Extraction succeeded but item formatting failed.")

    if not cleaned_items:
        return fallback_response("No gradeable items were found in this syllabus.")

    return {
        "success": True,
        "filename": file.filename,
        "item_count": len(cleaned_items),
        "items": cleaned_items,
    }