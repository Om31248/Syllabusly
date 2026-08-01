import { useState, useEffect, useRef, useMemo } from "react";
import "./App.css";

const UPLOAD_URL = "http://localhost:8000/api/upload-syllabus";
const STORAGE_KEY = "syllabusly.tasks";

const PRIORITY_META = {
  High: { icon: "🔥", label: "High" },
  Medium: { icon: "🟡", label: "Medium" },
  Low: { icon: "🔵", label: "Low" },
};

function loadStoredTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function formatDue(dateStr) {
  if (!dateStr || dateStr === "TBD") return "TBD";
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function hasRealDate(dateStr) {
  return Boolean(dateStr) && dateStr !== "TBD" && !Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime());
}

// All the date math below treats due_date as a plain YYYY-MM-DD calendar
// day, not a timestamp - that's why we build Date objects at noon UTC
// instead of midnight local time, so timezone offsets can never push us
// onto the wrong day.
function toCompactDate(dateStr) {
  return dateStr.replaceAll("-", "");
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nowAsICSTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeICSText(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildICS(tasks) {
  const scheduled = tasks.filter((t) => hasRealDate(t.due_date));
  const stamp = nowAsICSTimestamp();

  const events = scheduled.map((t) => {
    const start = toCompactDate(t.due_date);
    const end = toCompactDate(addDays(t.due_date, 1));
    const summary = escapeICSText(`${t.course_code}: ${t.title}`);
    const description = escapeICSText(
      `${t.type} · ${t.weight}% of final grade · ~${t.estimated_hours}h estimated`
    );

    return [
      "BEGIN:VEVENT",
      `UID:${t.id}@syllabusly.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      "END:VEVENT",
    ].join("\r\n");
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Syllabusly//Term Planner//EN",
    "CALSCALE:GREGORIAN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICS(tasks) {
  const ics = buildICS(tasks);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "syllabusly-schedule.ics";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function googleCalendarUrl(task) {
  if (!hasRealDate(task.due_date)) return null;

  const start = toCompactDate(task.due_date);
  const end = toCompactDate(addDays(task.due_date, 1));
  const details = `${task.type} · ${task.weight}% of final grade · ~${task.estimated_hours}h estimated study time`;

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${task.course_code}: ${task.title}`,
    dates: `${start}/${end}`,
    details,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function TaskCard({ task, onUpdate, onDelete }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDue, setEditingDue] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [dueDraft, setDueDraft] = useState(task.due_date || "");

  const priority = PRIORITY_META[task.priority] || PRIORITY_META.Low;
  const gcalUrl = googleCalendarUrl(task);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) onUpdate(task.id, { title: trimmed });
    else setTitleDraft(task.title);
  };

  const commitDue = () => {
    setEditingDue(false);
    if (dueDraft && dueDraft !== task.due_date) onUpdate(task.id, { due_date: dueDraft });
  };

  return (
    <div className="card" data-priority={task.priority}>
      <span className="card__tab" />

      <div className="card__top">
        <span className="badge-course">{task.course_code}</span>
        <span className="badge-priority" data-priority={task.priority} title={`${priority.label} priority`}>
          {priority.icon} {priority.label}
        </span>
      </div>

      {editingTitle ? (
        <input
          className="card__title-input"
          value={titleDraft}
          autoFocus
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.target.blur();
            if (e.key === "Escape") {
              setTitleDraft(task.title);
              setEditingTitle(false);
            }
          }}
        />
      ) : (
        <h3 className="card__title" onClick={() => setEditingTitle(true)}>
          {task.title}
        </h3>
      )}

      {editingDue ? (
        <input
          type="date"
          className="card__due-input"
          value={dueDraft}
          autoFocus
          onChange={(e) => setDueDraft(e.target.value)}
          onBlur={commitDue}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.target.blur();
            if (e.key === "Escape") setEditingDue(false);
          }}
        />
      ) : (
        <div className="card__due" onClick={() => setEditingDue(true)}>
          <span className="card__due-icon">📅</span>
          {formatDue(task.due_date)}
        </div>
      )}

      <div className="card__stats">
        <span>{task.weight}% weight</span>
        <span className="card__stats-divider">·</span>
        <span>{task.estimated_hours}h est.</span>
      </div>

      {gcalUrl && (
        <a className="card__gcal" href={gcalUrl} target="_blank" rel="noopener noreferrer">
          + Add to Google Calendar
        </a>
      )}

      <div className="card__footer">
        <span className="card__type">{task.type}</span>
        <button className="btn-delete" onClick={() => onDelete(task.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState(loadStoredTasks);
  const [search, setSearch] = useState("");
  const [activeCourse, setActiveCourse] = useState("All Courses");
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks]);

  const courses = useMemo(() => {
    const unique = [...new Set(tasks.map((t) => t.course_code))].sort();
    return ["All Courses", ...unique];
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => activeCourse === "All Courses" || t.course_code === activeCourse)
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.course_code.toLowerCase().includes(q))
      .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  }, [tasks, search, activeCourse]);

  const summary = useMemo(
    () => ({
      count: tasks.length,
      weight: tasks.reduce((sum, t) => sum + (Number(t.weight) || 0), 0),
      hours: tasks.reduce((sum, t) => sum + (Number(t.estimated_hours) || 0), 0),
    }),
    [tasks]
  );

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type === "application/pdf");
    if (!files.length) {
      setError("Only PDF files are supported.");
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(UPLOAD_URL, { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Upload failed for ${file.name} (${res.status})`);

        const data = await res.json();

        if (data.success === false) {
          throw new Error(data.error || `Couldn't extract anything from ${file.name}.`);
        }

        const incoming = Array.isArray(data) ? data : data.items || [];
        setTasks((prev) => [...prev, ...incoming]);
      }
    } catch (err) {
      setError(err.message || "Something went wrong reading that syllabus.");
    } finally {
      setIsUploading(false);
    }
  }

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function deleteTask(id) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <span className="header__mark">SYL</span>
          <div>
            <h1>Syllabusly</h1>
            <p>Drop a syllabus in, get your term mapped out.</p>
          </div>
        </div>
      </header>

      <div
        className={`dropzone ${isDragging ? "dropzone--active" : ""} ${isUploading ? "dropzone--busy" : ""}`}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isUploading) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (!isUploading) handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => e.target.files.length && handleFiles(e.target.files)}
        />
        {isUploading ? (
          <>
            <div className="spinner" />
            <p className="dropzone__title">Reading your syllabus…</p>
            <p className="dropzone__hint">Pulling out every deadline it can find</p>
          </>
        ) : (
          <>
            <p className="dropzone__title">Drop your syllabus PDF here</p>
            <p className="dropzone__hint">or click to browse · multiple files supported</p>
          </>
        )}
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {tasks.length > 0 && (
        <>
          <div className="dashboard">
            <div className="metric-card">
              <span className="metric-card__value">{summary.count}</span>
              <span className="metric-card__label">Total Deliverables</span>
            </div>
            <div className="metric-card">
              <span className="metric-card__value">{summary.weight}%</span>
              <span className="metric-card__label">Cumulative Weight</span>
            </div>
            <div className="metric-card">
              <span className="metric-card__value">{summary.hours}h</span>
              <span className="metric-card__label">Estimated Study Time</span>
            </div>
          </div>

          <div className="actions-bar">
            <button className="btn-export" onClick={() => downloadICS(tasks)}>
              ⬇ Export All to Calendar (.ics)
            </button>
          </div>

          <div className="controls">
            <input
              className="search-input"
              placeholder="Search by task or course code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="controls__count">
              {visibleTasks.length} of {tasks.length}
            </span>
          </div>

          <div className="pills">
            {courses.map((course) => (
              <button
                key={course}
                className={`pill ${activeCourse === course ? "pill--active" : ""}`}
                onClick={() => setActiveCourse(course)}
              >
                {course}
              </button>
            ))}
          </div>

          {visibleTasks.length > 0 ? (
            <div className="grid">
              {visibleTasks.map((task) => (
                <TaskCard key={task.id} task={task} onUpdate={updateTask} onDelete={deleteTask} />
              ))}
            </div>
          ) : (
            <p className="empty-state">Nothing matches that search.</p>
          )}
        </>
      )}

      {tasks.length === 0 && !isUploading && (
        <p className="empty-state">No deadlines yet — upload a syllabus to get started.</p>
      )}
    </div>
  );
}