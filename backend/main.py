from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
import io

app = FastAPI(title="Syllabusly API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/upload-syllabus")
async def upload_syllabus(file: UploadFile = File(...)):
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="File must be a PDF")

    try:
        pdf_bytes = await file.read()
        reader = PdfReader(io.BytesIO(pdf_bytes))
        raw_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse PDF: {e}")

    # Mock response — replace with real parsing/LLM extraction later.
    return {
        "filename": file.filename,
        "extracted_text_length": len(raw_text),
        "events": [
            {
                "title": "Midterm Exam Study Session",
                "course_code": "CSC101",
                "due_date": "2026-03-14",
                "recommended_study_days": ["2026-03-10", "2026-03-11", "2026-03-12"],
                "priority": "high",
            },
            {
                "title": "Problem Set 4",
                "course_code": "CSC101",
                "due_date": "2026-02-28",
                "recommended_study_days": ["2026-02-25", "2026-02-26"],
                "priority": "medium",
            },
            {
                "title": "Reading Response: Chapter 6",
                "course_code": "ENG210",
                "due_date": "2026-02-20",
                "recommended_study_days": ["2026-02-19"],
                "priority": "low",
            },
        ],
    }


@app.get("/")
def root():
    return {"status": "ok", "service": "Syllabusly API"}