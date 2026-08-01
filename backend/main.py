import os
import io
import re
import json
import uuid
import logging
from datetime import datetime

from dotenv import load_dotenv, find_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import pypdf
from groq import Groq

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

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MODEL_NAME = "llama-3.3-70b-versatile"

if not GROQ_API_KEY:
    # load_dotenv() only looks in the cwd (or a parent folder) for a .env.
    # If yours is somewhere else it just won't find it, no error, key
    # stays empty. Easiest fix: uncomment these two lines and drop in
    # the real path.
    #
    # load_dotenv("/absolute/path/to/your/.env")
    # GROQ_API_KEY = os.getenv("GROQ_API_KEY")
    dotenv_path = find_dotenv(usecwd=True)
    logger.warning(
        "GROQ_API_KEY not set. Looked for a .env at: %s - move it next "
        "to main.py, run uvicorn from that folder, or hardcode the path "
        "above.",
        dotenv_path or "<not found>",
    )

client = None
if GROQ_API_KEY:
    client = Groq(api_key=GROQ_API_KEY)
else:
    logger.warning("GROQ_API_KEY is not set - /api/upload-syllabus will fail until it is.")

VALID_TYPES = {"Exam", "Assignment", "Quiz", "Project"}

DEFAULT_YEAR = 2026

# Hard ceiling on what we'll ever send to the model, even after trimming.
# Last line of defense against a genuinely massive document (some syllabi
# run 30+ pages with huge appendices) blowing the token budget anyway.
MAX_PROMPT_CHARS = 9000

# If a page scores at least this many keyword hits, we treat it as likely
# to contain real gradeable content and keep it. Deliberately generic -
# these words show up on an assessments/schedule page in pretty much any
# syllabus template, not just this one school's.
PAGE_KEEP_THRESHOLD = 3

RELEVANT_KEYWORDS = (
    "assignment", "assessment", "exam", "midterm", "final exam",
    "quiz", "project", "presentation", "due date", "deadline",
    "worth", "weight", "grade", "grading", "%", "percent",
    "course schedule", "week 1", "week 2", "submission", "report",
    "evaluation", "marks",
)

# Pages that are mostly about these topics are almost never useful for
# extraction, even if a stray word overlaps with the keyword list above
# (e.g. a policy page that mentions "grade" once in passing). If a page
# trips several of these, that's a strong signal it's pure policy text.
BOILERPLATE_KEYWORDS = (
    "academic integrity", "accessibility", "accessible learning",
    "plagiarism", "code of conduct", "human rights", "gender inclusiv",
    "intellectual property", "student privacy", "wellness centre",
    "aacsb", "copyright act", "religious accommodation", "mental health",
)


# ---------------------------------------------------------------------------
# pdf extraction
# ---------------------------------------------------------------------------

def extract_pages_from_pdf(file_bytes):
    """Pull text out of a PDF, keeping pages separate rather than joining
    into one blob right away.

    This matters because PDF text extraction is unreliable about
    preserving paragraph breaks - a lot of PDFs extract as one giant wall
    of text with no blank lines anywhere, which makes "split on blank
    lines" useless for figuring out which chunk is about what. Page
    boundaries, on the other hand, are always reliable, since pypdf gives
    them to us directly."""
    reader = pypdf.PdfReader(io.BytesIO(file_bytes))

    if len(reader.pages) == 0:
        raise ValueError("PDF has no pages")

    pages_text = [page.extract_text() or "" for page in reader.pages]

    total_len = sum(len(p) for p in pages_text)
    if total_len < 40:
        raise ValueError("Could not extract meaningful text from PDF (likely scanned/image-based)")

    return pages_text


# ---------------------------------------------------------------------------
# text cleanup + relevance filtering
# ---------------------------------------------------------------------------

def strip_page_furniture(page_text: str) -> str:
    """Drop the stuff that repeats on nearly every page and adds nothing
    useful: lone page numbers, address/phone footers, bare URLs sitting
    on their own line. None of this is school-specific - it's just "does
    this line look like a footer" regardless of what the footer says."""
    cleaned_lines = []

    for line in page_text.split("\n"):
        stripped = line.strip()

        if not stripped:
            cleaned_lines.append(line)
            continue

        if re.fullmatch(r"\d{1,4}", stripped):
            continue  # lone page number

        looks_like_footer = (
            re.search(r"\b\d{3}[.\-]\d{3}[.\-]\d{4}\b", stripped)
            or re.search(r"\b(ave|avenue|street|st\.|blvd|road|rd\.)\b", stripped, re.IGNORECASE)
            or (len(stripped) < 90 and re.search(r"\.(ca|com|edu|org)\b", stripped, re.IGNORECASE))
        )
        if looks_like_footer:
            continue

        cleaned_lines.append(line)

    collapsed = "\n".join(cleaned_lines)
    collapsed = re.sub(r"\n{3,}", "\n\n", collapsed)
    return collapsed.strip()


def score_page(page_text: str) -> int:
    """Count how many "this page is probably about grades/deadlines"
    keywords show up, minus a penalty for boilerplate keywords. Simple,
    but works fine for deciding which pages are worth sending."""
    lowered = page_text.lower()

    relevance_hits = sum(1 for kw in RELEVANT_KEYWORDS if kw in lowered)
    boilerplate_hits = sum(1 for kw in BOILERPLATE_KEYWORDS if kw in lowered)

    return relevance_hits - boilerplate_hits


def select_relevant_pages(pages_text: list) -> str:
    """Clean each page, score it, and keep only the pages that look like
    they're actually about gradeable deliverables. Falls back to using
    every cleaned page if scoring somehow leaves us with almost nothing -
    better to send more than to send an empty prompt."""
    cleaned_pages = [strip_page_furniture(p) for p in pages_text]

    kept_pages = [
        page for page in cleaned_pages
        if score_page(page) >= PAGE_KEEP_THRESHOLD
    ]

    combined = "\n\n".join(kept_pages)

    if len(combined) < 300:
        combined = "\n\n".join(cleaned_pages)

    return combined


def prepare_syllabus_text(pages_text: list) -> str:
    """Full pipeline: clean + filter down to relevant pages, then apply a
    hard character cap as a final safety net."""
    focused = select_relevant_pages(pages_text)
    return focused[:MAX_PROMPT_CHARS]


# ---------------------------------------------------------------------------
# prompt + model call
# ---------------------------------------------------------------------------

def build_prompt(pages_text: list) -> str:
    trimmed = prepare_syllabus_text(pages_text)

    # Note: we don't ask the model for "priority" - that gets computed
    # from weight afterward (see derive_priority). Fewer fields to explain
    # means a shorter prompt every single call.
    return f"""Extract every graded deliverable (assignment, quiz, midterm, project,
final exam - anything with a due date and/or grade weight) from the syllabus
excerpt below. This excerpt has already been trimmed down to the sections
most likely to contain that information, from a syllabus for an unknown
course.

Figure out the course code from whatever appears in the text itself - do
not guess or invent one if it isn't present.

Return ONLY a JSON array, nothing else - no code fences, no commentary.
Each item needs exactly these fields:
- course_code: string, taken from the document, "UNKNOWN" if truly absent
- title: short name, e.g. "Midterm Exam" or "Case Study Analysis"
- due_date: "YYYY-MM-DD" (assume {DEFAULT_YEAR} if year is missing, else "TBD")
- type: one of Exam, Assignment, Quiz, Project
- weight: integer percent of final grade, 0 if not stated
- estimated_hours: integer, a reasonable prep-time estimate for this item

Skip readings, participation-only items with no fixed date, and anything
that isn't a discrete gradeable deliverable.

Syllabus excerpt:
---
{trimmed}
---
"""


def call_groq(prompt: str) -> str:
    completion = client.chat.completions.create(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": "You output JSON only, no commentary."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    return completion.choices[0].message.content


def clean_json_response(raw_text: str) -> list:
    """Grab the outermost [ ... ] before parsing, just to be safe against
    stray whitespace or fences.

    Heads up: the Groq call uses response_format={"type": "json_object"},
    which means the model technically has to return an object, not a bare
    array. If it wraps things like {"items": [...]}, this still works fine
    since we're just scanning for brackets - but if it returns an object
    with no array anywhere inside, this blows up on purpose instead of
    quietly returning garbage."""
    text = raw_text.strip().strip("`")

    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON array found in model response")

    parsed = json.loads(text[start:end + 1])

    if not isinstance(parsed, list):
        raise ValueError("Model response was not a JSON array")

    return parsed


# ---------------------------------------------------------------------------
# normalization (computed ourselves instead of trusting the model, so the
# prompt can stay short and the output is always guaranteed consistent)
# ---------------------------------------------------------------------------

def safe_int(value, default: int = 0) -> int:
    """The model occasionally hands back "20%" or "20.0" instead of a clean
    int - this just saves repeating the same try/except everywhere."""
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
    """Coerce whatever comes back into YYYY-MM-DD or "TBD". Handles a
    year-less date (e.g. "03-15") by assuming DEFAULT_YEAR."""
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
    malformed item. Priority is computed here from weight rather than
    asked of the model - it's deterministic, so there's no reason to
    spend prompt space explaining the High/Medium/Low cutoffs."""
    weight = safe_int(item.get("weight"), default=0)
    estimated_hours = safe_int(item.get("estimated_hours"), default=0)

    item_type = item.get("type")
    if item_type not in VALID_TYPES:
        item_type = "Assignment"

    due_date = normalize_due_date(item.get("due_date"))

    return {
        "id": str(uuid.uuid4()),
        "course_code": item.get("course_code") or "UNKNOWN",
        "title": item.get("title") or "Untitled item",
        "due_date": due_date,
        "type": item_type,
        "weight": weight,
        "priority": derive_priority(weight),
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

    if not GROQ_API_KEY:
        return fallback_response("Server is missing GROQ_API_KEY - contact the administrator.")

    try:
        file_bytes = await file.read()
    except Exception:
        logger.exception("Failed to read uploaded file")
        return fallback_response("Could not read the uploaded file.")

    # Step 1: pull text out of the PDF, page by page
    try:
        pages_text = extract_pages_from_pdf(file_bytes)
    except ValueError as e:
        logger.warning(f"PDF extraction issue for {file.filename}: {e}")
        return fallback_response(str(e))
    except Exception:
        logger.exception(f"Unexpected error extracting text from {file.filename}")
        return fallback_response("Unexpected error while reading the PDF.")

    # Step 2 + 3: trim down to the relevant pages, send to Groq, parse JSON
    try:
        prompt = build_prompt(pages_text)
        raw_response = call_groq(prompt)
        parsed_items = clean_json_response(raw_response)
    except json.JSONDecodeError:
        logger.exception("Groq response was not valid JSON")
        return fallback_response("The AI response could not be parsed. Please try again.")
    except Exception:
        logger.exception("Groq extraction failed")
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