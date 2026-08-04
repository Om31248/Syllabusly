import { useState, useEffect, useRef, useMemo } from "react";

const UPLOAD_URL = "http://localhost:8000/api/upload-syllabus";
const STORAGE_KEY = "syllabusly.tasks";

const PRIORITY_META = {
  High: { icon: "●", label: "High" },
  Medium: { icon: "●", label: "Medium" },
  Low: { icon: "●", label: "Low" },
};

// no schema versioning here - if the task shape ever changes we'll
// just silently drop bad rows instead of migrating them. fine for now.
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

// due_date is always a plain YYYY-MM-DD, not a real timestamp.
// noon UTC below is deliberate - midnight local time was rolling
// dates back a day for anyone west of UTC. don't "simplify" this.
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
        // title attr is the only way to see the full name once it's
        // truncated - card's too tight for wrapping without blowing
        // up the grid height
        <h3 className="card__title" onClick={() => setEditingTitle(true)} title={task.title}>
          {task.title}
        </h3>
      )}

      <div className="card__meta">
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
          <span className="card__meta-item card__meta-item--due" onClick={() => setEditingDue(true)}>
            📅 {formatDue(task.due_date)}
          </span>
        )}
        <span className="card__meta-dot">·</span>
        <span className="card__meta-item">{task.weight}% weight</span>
        <span className="card__meta-dot">·</span>
        <span className="card__meta-item">{task.estimated_hours}h est.</span>
      </div>

      <div className="card__footer">
        <span className="card__type">{task.type}</span>
        <div className="card__footer-actions">
          {gcalUrl && (
            <a className="card__gcal" href={gcalUrl} target="_blank" rel="noopener noreferrer">
              + Calendar
            </a>
          )}
          <button className="btn-delete" onClick={() => onDelete(task.id)}>
            Delete
          </button>
        </div>
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
      // sequential on purpose - the extraction endpoint is doing real
      // parsing work per PDF, firing them all at once just queues up
      // on the server and makes the error messages harder to attribute
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
      <style>{APP_CSS}</style>

      {/* left-aligned navbar, not a centered hero - the old centered
         version looked fine narrow but just wasted space once the
         container widened out */}
      <header className="navbar">
        <div className="navbar__brand">
          <span className="navbar__glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path
                d="M4 4.5h16M4 9.5h16M4 14.5h10M4 19.5h6"
                stroke="url(#slGrad)"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <defs>
                <linearGradient id="slGrad" x1="4" y1="4.5" x2="20" y2="19.5" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#6366f1" />
                  <stop offset="1" stopColor="#22d3ee" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <div className="navbar__titles">
            <h1>Syllabusly</h1>
            <p>Drop a syllabus in, get your term mapped out.</p>
          </div>
        </div>
      </header>

      {/* full-width hero dropzone - this is the main call to action so
         it gets to breathe across the whole container, not squeezed
         into a corner of the navbar */}
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
            <span className="spinner" />
            <span className="dropzone__text">Reading your syllabus…</span>
          </>
        ) : (
          <>
            <span className="dropzone__icon" aria-hidden="true">⤒</span>
            <span className="dropzone__text">
              Drop syllabus PDFs here <span className="dropzone__text-muted">or click to browse · multiple files supported</span>
            </span>
          </>
        )}
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {tasks.length > 0 && (
        <>
          <div className="toolbar">
            <div className="toolbar__metrics">
              <div className="metric">
                <span className="metric__value">{summary.count}</span>
                <span className="metric__label">Deliverables</span>
              </div>
              <div className="metric">
                <span className="metric__value">{summary.weight}%</span>
                <span className="metric__label">Weight</span>
              </div>
              <div className="metric">
                <span className="metric__value">{summary.hours}h</span>
                <span className="metric__label">Prep Time</span>
              </div>
            </div>

            <input
              className="search-input"
              placeholder="Search by task or course code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />

            <button className="btn-export" onClick={() => downloadICS(tasks)}>
              ⬇ Export .ics
            </button>
          </div>

          <div className="controls-row">
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
            <span className="controls__count">
              {visibleTasks.length} of {tasks.length}
            </span>
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

// keeping this as a plain template string injected via <style> instead of
// a separate .css file - only reason is the "single file" ask. in a real
// project this belongs in its own stylesheet.
const APP_CSS = `
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap");

:root {
  --bg: #09090b;
  --surface: rgba(255, 255, 255, 0.03);
  --surface-raised: #18181b;
  --border: #27272a;
  --border-hover: #3a3a40;
  --text: #f8fafc;
  --text-muted: #8b8d98;

  --accent: #6366f1;
  --accent-2: #22d3ee;
  --accent-soft: rgba(99, 102, 241, 0.14);
  --accent-glow: rgba(99, 102, 241, 0.28);

  --high: #818cf8;
  --high-soft: rgba(129, 140, 248, 0.14);
  --medium: #22d3ee;
  --medium-soft: rgba(34, 211, 238, 0.13);
  --low: #71717a;
  --low-soft: rgba(113, 113, 122, 0.16);

  --radius: 12px;
  /* single source of truth for container width - referenced by .app
     below. bumped from the old 700px-ish default to actually use a
     desktop monitor */
  --container-max: 1400px;
}

* { box-sizing: border-box; }

html, body, #root {
  background: var(--bg);
}

.app {
  margin: 0 auto;
  min-height: 100vh;
  width: 100%;
  max-width: var(--container-max);
  background: var(--bg);
  background-image:
    radial-gradient(ellipse 900px 460px at 12% -8%, rgba(99, 102, 241, 0.14), transparent 60%),
    radial-gradient(ellipse 700px 460px at 100% 0%, rgba(34, 211, 238, 0.08), transparent 55%);
  background-repeat: no-repeat;
  color: var(--text);
  font-family: "Inter", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding: 40px 32px 80px;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* navbar */

.navbar {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
}

.navbar__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.navbar__titles {
  text-align: center;
}

.navbar__titles h1 {
  font-family: "Space Grotesk", sans-serif;
  font-size: 24px;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #ffffff 20%, #a5a8b8);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.navbar__titles p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

/* dropzone: full-width horizontal hero bar */

.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  border: 1.5px dashed var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 20px 24px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.dropzone:hover { border-color: var(--border-hover); }

.dropzone--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.dropzone--busy { cursor: default; }

.dropzone__icon {
  font-size: 17px;
  color: var(--accent-2);
}

.dropzone__text {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--text);
}

.dropzone__text-muted {
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 6px;
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid var(--border);
  border-top-color: var(--accent-2);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 1.4s; }
  .dropzone, .card, .pill, .btn-export { transition: none !important; }
}

.banner {
  margin-top: 12px;
  padding: 11px 16px;
  border-radius: 8px;
  font-size: 13.5px;
  background: var(--high-soft);
  border: 1px solid rgba(129, 140, 248, 0.3);
  color: #c7d2fe;
}

/* toolbar: metrics + search + export, one row */

.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  flex-wrap: wrap;
}

.toolbar__metrics {
  display: flex;
  gap: 22px;
  flex-shrink: 0;
}

.metric { display: flex; flex-direction: column; gap: 1px; }

.metric__value {
  font-family: "Space Grotesk", sans-serif;
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
}

.metric__label {
  font-size: 10.5px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.search-input {
  flex: 1;
  min-width: 160px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  transition: border-color 0.15s ease;
}

.search-input::placeholder { color: var(--text-muted); }
.search-input:focus { outline: none; border-color: var(--accent); }

.btn-export {
  flex-shrink: 0;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #06060a;
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-family: "Space Grotesk", sans-serif;
  font-size: 13.5px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 6px 18px var(--accent-glow);
  transition: transform 0.15s ease, filter 0.15s ease;
  white-space: nowrap;
}

.btn-export:hover { transform: translateY(-1px); filter: brightness(1.05); }
.btn-export:active { transform: translateY(0); }

/* filter pills row + count */

.controls-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}

.pills { display: flex; flex-wrap: wrap; gap: 7px; }

.pill {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: 6px 13px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.pill:hover { border-color: var(--border-hover); color: var(--text); }

.pill--active {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
  color: #06060a;
  font-weight: 700;
}

.controls__count {
  font-family: "IBM Plex Mono", monospace;
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* task grid - this is the whole point of the container being wider.
   at 1400px with 300px min cards you get a clean 4-up, at ~1050px
   (laptop) it settles to 3-up, tablet drops to 2, phone to 1. no
   breakpoints needed, auto-fill does the work */

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.card {
  display: flex;
  flex-direction: column;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-top: 2px solid var(--low);
  border-radius: 10px;
  padding: 14px 16px 12px;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.card:hover { border-color: var(--border-hover); transform: translateY(-2px); }

.card[data-priority="High"] { border-top-color: var(--high); }
.card[data-priority="Medium"] { border-top-color: var(--medium); }
.card[data-priority="Low"] { border-top-color: var(--low); }

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.badge-course {
  font-family: "IBM Plex Mono", monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--accent-2);
  background: var(--accent-soft);
  padding: 3px 7px;
  border-radius: 5px;
}

.badge-priority {
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.badge-priority[data-priority="High"] { color: var(--high); background: var(--high-soft); }
.badge-priority[data-priority="Medium"] { color: var(--medium); background: var(--medium-soft); }
.badge-priority[data-priority="Low"] { color: var(--low); background: var(--low-soft); }
.badge-priority span { font-size: 8px; }

.card__title {
  font-family: "Space Grotesk", sans-serif;
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 9px;
  line-height: 1.3;
  cursor: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s ease;
}

.card__title:hover { color: var(--accent-2); }

.card__title-input {
  width: 100%;
  font-family: "Space Grotesk", sans-serif;
  font-size: 15px;
  font-weight: 600;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--text);
  padding: 5px 7px;
  margin-bottom: 9px;
}

.card__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-muted);
  margin-bottom: 11px;
}

.card__meta-item--due { cursor: pointer; }
.card__meta-item--due:hover { color: var(--text); }
.card__meta-dot { opacity: 0.5; }

.card__due-input {
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--text);
  font-family: inherit;
  font-size: 11.5px;
  padding: 2px 5px;
}

.card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 9px;
  margin-top: auto;
  border-top: 1px solid var(--border);
}

.card__type {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.card__footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card__gcal {
  font-size: 11px;
  font-weight: 500;
  color: var(--accent-2);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s ease;
}

.card__gcal:hover { border-color: var(--accent-2); }

.btn-delete {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 5px;
  transition: color 0.15s ease, background 0.15s ease;
}

.btn-delete:hover { color: var(--high); background: var(--high-soft); }

/* empty state */

.empty-state {
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
  margin-top: 40px;
}

/* responsive */

@media (max-width: 720px) {
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar__metrics { justify-content: space-between; }
  .controls-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .controls__count { text-align: right; }
  .app { padding: 32px 18px 64px; }
}
`;