import { useState, useCallback } from "react";
import axios from "axios";
import "./App.css";

const PRIORITY_LABELS = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

function App() {
  const [file, setFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = useCallback(async (selectedFile) => {
    if (!selectedFile) return;

    if (selectedFile.type !== "application/pdf") {
      setError("That doesn't look like a PDF. Try again with a .pdf file.");
      return;
    }

    setFile(selectedFile);
    setError(null);
    setLoading(true);
    setEvents(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await axios.post(
        "http://localhost:8000/api/upload-syllabus",
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      setEvents(res.data.events);
    } catch (err) {
      console.error(err);
      setError("Couldn't parse that syllabus. Give it another shot.");
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    handleFile(dropped);
  };

  const onFileInput = (e) => {
    handleFile(e.target.files?.[0]);
  };

  return (
    <div className="page">
      <header className="header">
        <h1>Syllabusly</h1>
        <p>Drop in a syllabus, get your week sorted out.</p>
      </header>

      <label
        className={`dropzone ${isDragging ? "dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="application/pdf"
          onChange={onFileInput}
          hidden
        />
        <div className="dropzone__icon">📄</div>
        {file ? (
          <p className="dropzone__filename">{file.name}</p>
        ) : (
          <>
            <p className="dropzone__title">Drag your syllabus here</p>
            <p className="dropzone__hint">or click to browse (.pdf only)</p>
          </>
        )}
      </label>

      {error && <p className="error">{error}</p>}

      {loading && (
        <div className="loading">
          <div className="spinner" />
          <p>Reading through your syllabus...</p>
        </div>
      )}

      {events && (
        <section className="schedule">
          <h2>Your weekly schedule</h2>
          <div className="card-grid">
            {events.map((event, i) => (
              <div className="card" key={i}>
                <div className="card__top">
                  <span className="course-code">{event.course_code}</span>
                  <span className={`badge badge--${event.priority}`}>
                    {PRIORITY_LABELS[event.priority] || event.priority}
                  </span>
                </div>
                <h3 className="card__title">{event.title}</h3>
                <p className="card__due">Due {formatDate(event.due_date)}</p>
                <div className="card__days">
                  {event.recommended_study_days.map((day) => (
                    <span className="day-chip" key={day}>
                      {formatDate(day)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default App;