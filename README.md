# Syllabusly

Drop in a syllabus PDF, get your whole term mapped out in seconds.

Syllabusly reads your syllabus, pulls out every assignment, quiz, midterm, and exam (with due dates and grade weights), and turns it into a clean dashboard. It can also build you a day by day study plan and export everything to Google Calendar or as an .ics file.

## What it does

- Upload one or more syllabus PDFs
- AI extracts every graded item: due date, weight, type, estimated prep time
- See a dashboard broken down by course, with total weight and prep hours
- Get warned if deadlines are stacking up in the same week
- Auto-generate a study schedule based on how much each item is worth
- Export to Google Calendar or download as .ics

## Tech stack

**Frontend:** React, Vite
**Backend:** Python, FastAPI
**AI:** Groq (LLM extraction)
**PDF parsing:** pypdf

## How it works

1. You drop a PDF in
2. The backend pulls the text out, filters it down to the pages likely to have deadlines/grading info (so it doesn't blow up on long syllabi)
3. That trimmed text gets sent to an LLM, which returns a structured list of every deliverable
4. The frontend turns that into cards you can edit, search, and filter by course
5. Optional: hit "Study Plan" and it spreads out prep time across the days leading up to each deadline

## Running it locally

**Backend**
```bash
cd backend
pip install -r requirements.txt
```
Create a `.env` file in the `backend` folder with:
```
GROQ_API_KEY=your_key_here
FRONTEND_ORIGIN=http://localhost:5173
```
Then run:
```bash
uvicorn main:app --reload
```

**Frontend**
```bash
npm install
npm run dev
```

Open `http://localhost:5173` and drop in a syllabus.

## Notes

- Only PDF syllabi are supported right now
- If a syllabus is scanned as an image (no real text layer), extraction won't work
