import { useState, useEffect, useRef, useMemo } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const UPLOAD_URL = `${API_BASE}/api/upload-syllabus`;
const SCHEDULE_URL = `${API_BASE}/api/generate-schedule`;
const STORAGE_KEY = "syllabusly.tasks";

const PRIORITY_META = {
  High: { icon: "●", label: "High" },
  Medium: { icon: "●", label: "Medium" },
  Low: { icon: "●", label: "Low" },
};

const FEATURE_CARDS = [
  { icon: "⚡", title: "Instant AI Extraction", desc: "Parses deadlines & weights in under 500ms." },
  { icon: "⚠️", title: "Workload", desc: "Automatically flags high-stress collision weeks." },
  { icon: "📅", title: "1-Click Export", desc: "Sync directly with Google Calendar or .ics." },
];

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

function formatHoursMinutes(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function formatDueLong(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function hasRealDate(dateStr) {
  return Boolean(dateStr) && dateStr !== "TBD" && !Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime());
}

function toCompactDate(dateStr) {
  return dateStr.replaceAll("-", "");
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dayIdx = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIdx);
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

const STUDY_BLOCK_START_HOUR = 18;

function layoutStudyBlocksForDay(blocks) {
  let cursorMinutes = STUDY_BLOCK_START_HOUR * 60;
  return blocks.map((b) => {
    const startMinutes = cursorMinutes;
    const durationMinutes = Math.round(b.hours * 60);
    cursorMinutes += durationMinutes;
    return { ...b, startMinutes, endMinutes: cursorMinutes };
  });
}

function minutesToICSDateTime(dateStr, minutes) {
  const base = new Date(`${dateStr}T00:00:00`);
  base.setMinutes(base.getMinutes() + minutes);
  const y = base.getFullYear();
  const mo = String(base.getMonth() + 1).padStart(2, "0");
  const da = String(base.getDate()).padStart(2, "0");
  const hh = String(base.getHours()).padStart(2, "0");
  const mm = String(base.getMinutes()).padStart(2, "0");
  return `${y}${mo}${da}T${hh}${mm}00`;
}

function buildStudyBlockEvents(scheduleBlocks) {
  const byDay = {};
  for (const b of scheduleBlocks) {
    if (!byDay[b.date]) byDay[b.date] = [];
    byDay[b.date].push(b);
  }

  const stamp = nowAsICSTimestamp();
  const events = [];

  for (const [date, dayBlocks] of Object.entries(byDay)) {
    const laidOut = layoutStudyBlocksForDay(dayBlocks);

    for (const b of laidOut) {
      const start = minutesToICSDateTime(date, b.startMinutes);
      const end = minutesToICSDateTime(date, b.endMinutes);
      const summary = escapeICSText(`Study: ${b.course_code} – ${b.title}`);
      const description = escapeICSText(`${formatHoursMinutes(b.hours)} prep block for ${b.title}`);

      events.push(
        [
          "BEGIN:VEVENT",
          `UID:study-${b.task_id}-${date}-${b.startMinutes}@syllabusly.app`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${start}`,
          `DTEND:${end}`,
          `SUMMARY:${summary}`,
          `DESCRIPTION:${description}`,
          "END:VEVENT",
        ].join("\r\n")
      );
    }
  }

  return events;
}

function buildICS(tasks, scheduleBlocks = []) {
  const scheduled = tasks.filter((t) => hasRealDate(t.due_date));
  const stamp = nowAsICSTimestamp();

  const dueEvents = scheduled.map((t) => {
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

  const studyEvents = buildStudyBlockEvents(scheduleBlocks);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Syllabusly//Term Planner//EN",
    "CALSCALE:GREGORIAN",
    ...dueEvents,
    ...studyEvents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICS(tasks, scheduleBlocks = []) {
  const ics = buildICS(tasks, scheduleBlocks);
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

function StudyDay({ date, blocks }) {
  const totalHours = blocks.reduce((sum, b) => sum + b.hours, 0);
  const fillPct = Math.min(100, (totalHours / 5) * 100);

  return (
    <div className="study-day">
      <div className="study-day__header">
        <span className="study-day__date">{formatDueLong(date)}</span>
        <span className="study-day__hours">{formatHoursMinutes(totalHours)}</span>
      </div>
      <div className="study-day__bar">
        <div className="study-day__bar-fill" style={{ width: `${fillPct}%` }} />
      </div>
      <div className="study-day__blocks">
        {blocks.map((b) => (
          <div className="study-block" key={`${b.task_id}-${b.date}-${b.hours}`}>
            <span className="badge-course">{b.course_code}</span>
            <span className="study-block__title">{b.title}</span>
            <span className="study-block__hours">{formatHoursMinutes(b.hours)}</span>
          </div>
        ))}
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
  const [errors, setErrors] = useState([]);
  const [lastLatencyMs, setLastLatencyMs] = useState(null);

  const fileInputRef = useRef(null);

  const [showStudyPlan, setShowStudyPlan] = useState(false);
  const [scheduleBlocks, setScheduleBlocks] = useState([]);
  const [scheduleSkipped, setScheduleSkipped] = useState([]);
  const [scheduleSkipReasons, setScheduleSkipReasons] = useState({});
  const [isScheduling, setIsScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState(null);
  const [scheduleStale, setScheduleStale] = useState(false);

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

  const summaryByCourse = useMemo(() => {
    const byCourse = {};
    for (const t of tasks) {
      if (!byCourse[t.course_code]) byCourse[t.course_code] = { count: 0, weight: 0, hours: 0 };
      byCourse[t.course_code].count += 1;
      byCourse[t.course_code].weight += Number(t.weight) || 0;
      byCourse[t.course_code].hours += Number(t.estimated_hours) || 0;
    }
    return byCourse;
  }, [tasks]);

  const busiestWeek = useMemo(() => {
    const buckets = {};
    for (const t of tasks) {
      if (!hasRealDate(t.due_date)) continue;
      if (!Number(t.weight)) continue;
      const wk = getWeekStart(t.due_date);
      if (!buckets[wk]) buckets[wk] = { weekStart: wk, count: 0, weight: 0, hours: 0 };
      buckets[wk].count += 1;
      buckets[wk].weight += Number(t.weight) || 0;
      buckets[wk].hours += Number(t.estimated_hours) || 0;
    }
    const weeks = Object.values(buckets).filter((w) => w.count >= 2);
    if (!weeks.length) return null;
    weeks.sort((a, b) => b.count - a.count || b.weight - a.weight);
    return weeks[0];
  }, [tasks]);

  const liveTaskIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);
  const liveScheduleBlocks = useMemo(
    () => scheduleBlocks.filter((b) => liveTaskIds.has(b.task_id)),
    [scheduleBlocks, liveTaskIds]
  );

  const scheduleByDay = useMemo(() => {
    const map = {};
    for (const b of liveScheduleBlocks) {
      if (!map[b.date]) map[b.date] = [];
      map[b.date].push(b);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [liveScheduleBlocks]);

  const skipBreakdown = useMemo(() => {
    let noPrepNeeded = 0;
    let didntFit = 0;
    for (const id of scheduleSkipped) {
      if (scheduleSkipReasons[id] === "no_weight_no_prep_needed") noPrepNeeded += 1;
      else didntFit += 1;
    }
    return { noPrepNeeded, didntFit };
  }, [scheduleSkipped, scheduleSkipReasons]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type === "application/pdf");
    if (!files.length) {
      setErrors(["Only PDF files are supported."]);
      return;
    }

    setIsUploading(true);
    setErrors([]);

    const collectedErrors = [];
    const collectedTasks = [];

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(UPLOAD_URL, { method: "POST", body: formData });
        if (!res.ok) throw new Error(`Upload failed for ${file.name} (${res.status})`);

        const data = await res.json();

        if (data.success === false) {
          throw new Error(data.error || `Couldn't extract anything from ${file.name}.`);
        }

        const incoming = Array.isArray(data) ? data : data.items || [];
        collectedTasks.push(...incoming);

        if (data.warning) {
          collectedErrors.push(`${file.name}: ${data.warning}`);
        }
        if (typeof data.latency_ms === "number") {
          setLastLatencyMs(data.latency_ms);
        }
      } catch (err) {
        collectedErrors.push(err.message || `Something went wrong reading ${file.name}.`);
      }
    }

    if (collectedTasks.length) {
      setTasks((prev) => [...prev, ...collectedTasks]);
    }
    setErrors(collectedErrors);
    setIsUploading(false);
  }

  async function generateStudyPlan() {
    setShowStudyPlan(true);
    setIsScheduling(true);
    setScheduleError(null);

    try {
      const res = await fetch(SCHEDULE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks }),
      });

      if (!res.ok) throw new Error(`Scheduler request failed (${res.status})`);

      const data = await res.json();
      setScheduleBlocks(data.blocks || []);
      setScheduleSkipped(data.skipped_task_ids || []);
      setScheduleSkipReasons(data.skip_reasons || {});
      setScheduleStale(false);
    } catch (err) {
      setScheduleError(err.message || "Couldn't generate a study plan right now.");
    } finally {
      setIsScheduling(false);
    }
  }

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (scheduleBlocks.length) setScheduleStale(true);
  }

  function deleteTask(id) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (scheduleBlocks.length) setScheduleStale(true);
  }

  const isEmpty = tasks.length === 0;

  const dropzone = (
    <div
      className={`dropzone ${isEmpty ? "dropzone--hero" : "dropzone--compact"} ${
        isDragging ? "dropzone--active" : ""
      } ${isUploading ? "dropzone--busy" : ""}`}
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
      ) : isEmpty ? (
        <>
          <span className="dropzone__icon dropzone__icon--hero" aria-hidden="true">⤒</span>
          <span className="dropzone__title">Drop syllabus PDFs here</span>
          <span className="dropzone__hint">or click to browse · multiple files supported</span>
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
  );

  return (
    <div className="app">
      <style>{APP_CSS}</style>

      <header className={`header ${isEmpty ? "header--hero" : "header--compact"}`}>
        <div className="header__brand">
          <span className="header__glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width={isEmpty ? "28" : "20"} height={isEmpty ? "28" : "20"} fill="none">
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
          <div className="header__titles">
            <h1>Syllabusly</h1>
            <p>
              {isEmpty
                ? "Drop a syllabus in, get your entire term mapped out in seconds."
                : "Drop a syllabus in, get your term mapped out."}
            </p>
          </div>
        </div>
      </header>

      {isEmpty ? (
        <div className="landing">
          {dropzone}

          {lastLatencyMs !== null && errors.length === 0 && (
            <p className="latency-note">
              ⚡ Extracted in {lastLatencyMs < 1000 ? `${Math.round(lastLatencyMs)}ms` : `${(lastLatencyMs / 1000).toFixed(1)}s`}
            </p>
          )}

          {errors.length > 0 && (
            <div className="banner banner--error">
              {errors.map((msg, i) => (
                <div key={i}>{msg}</div>
              ))}
            </div>
          )}

          <div className="feature-grid">
            {FEATURE_CARDS.map((f) => (
              <div className="feature-card" key={f.title}>
                <span className="feature-card__icon">{f.icon}</span>
                <h3 className="feature-card__title">{f.title}</h3>
                <p className="feature-card__desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {dropzone}

          {lastLatencyMs !== null && errors.length === 0 && (
            <p className="latency-note">
              ⚡ Extracted in {lastLatencyMs < 1000 ? `${Math.round(lastLatencyMs)}ms` : `${(lastLatencyMs / 1000).toFixed(1)}s`}
            </p>
          )}

          {errors.length > 0 && (
            <div className="banner banner--error">
              {errors.map((msg, i) => (
                <div key={i}>{msg}</div>
              ))}
            </div>
          )}

          {busiestWeek && (
            <div className="heatmap-banner">
              ⚠️ Workload: {busiestWeek.count} deadlines collide the week of{" "}
              {formatDue(busiestWeek.weekStart)} ({busiestWeek.weight}% weight, {busiestWeek.hours}h)
            </div>
          )}

          <div className="toolbar">
            <div className="toolbar__metrics">
              <div className="metric">
                <span className="metric__value">{summary.count}</span>
                <span className="metric__label">Deliverables</span>
              </div>

              {activeCourse === "All Courses" ? (
                Object.entries(summaryByCourse).map(([course, s]) => (
                  <div className="metric" key={course}>
                    <span className="metric__value">{Math.round(s.weight * 10) / 10}%</span>
                    <span className="metric__label">{course} Weight</span>
                  </div>
                ))
              ) : (
                <div className="metric">
                  <span className="metric__value">
                    {Math.round((summaryByCourse[activeCourse]?.weight || 0) * 10) / 10}%
                  </span>
                  <span className="metric__label">Weight</span>
                </div>
              )}

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

            <button
              className="btn-plan"
              onClick={() => (showStudyPlan ? setShowStudyPlan(false) : generateStudyPlan())}
              disabled={isScheduling}
            >
              {isScheduling ? "Building…" : showStudyPlan ? "Hide Study Plan" : "📚 Study Plan"}
            </button>

            <button
              className="btn-export"
              onClick={() => downloadICS(tasks, liveScheduleBlocks)}
              title={
                liveScheduleBlocks.length
                  ? "Includes due dates + your study blocks"
                  : "Includes due dates (generate a study plan first to include study blocks)"
              }
            >
              ⬇ Export .ics
            </button>
          </div>

          {showStudyPlan && (
            <div className="study-panel">
              {isScheduling ? (
                <div className="study-panel__loading">
                  <span className="spinner" />
                  <span>Working out your study blocks…</span>
                </div>
              ) : scheduleError ? (
                <div className="banner banner--error">{scheduleError}</div>
              ) : scheduleByDay.length === 0 ? (
                <p className="study-panel__empty">
                  Nothing to schedule yet — tasks need a real due date, some estimated hours, and
                  actual weight on your grade (ungraded modules don't get study blocks).
                </p>
              ) : (
                <>
                  {scheduleStale && (
                    <p className="study-panel__note">
                      Tasks changed since this plan was built — hit Study Plan again to refresh it.
                    </p>
                  )}
                  <div className="study-panel__row">
                    {scheduleByDay.map(([date, blocks]) => (
                      <StudyDay key={date} date={date} blocks={blocks} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

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
    </div>
  );
}

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

.header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-bottom: 22px;
}

.header--hero {
  margin-top: 6vh;
  margin-bottom: 36px;
}

.header__brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.header--compact .header__brand {
  flex-direction: row;
  gap: 12px;
}

.header__titles {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.header__titles h1 {
  font-family: "Space Grotesk", sans-serif;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.01em;
  line-height: 1.15;
  display: inline-block;
  background: linear-gradient(135deg, var(--text) 15%, var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

.header--compact .header__titles h1 { font-size: 24px; }
.header--hero .header__titles h1 { font-size: 3.5rem; }

.header__titles p {
  margin: 6px 0 0;
  color: var(--text-muted);
}

.header--compact .header__titles p { font-size: 13px; margin-top: 2px; }
.header--hero .header__titles p { font-size: 16px; max-width: 480px; }

.landing {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: 1.5px dashed var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.dropzone:hover { border-color: var(--border-hover); }

.dropzone--hero {
  flex-direction: column;
  gap: 10px;
  max-width: 640px;
  min-height: 200px;
  border: 1px dashed #3f3f46;
  padding: 32px;
}

.dropzone--compact {
  gap: 10px;
  padding: 20px 24px;
}

.dropzone--active {
  border-color: var(--accent-2);
  background: var(--accent-soft);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.dropzone--busy { cursor: default; }

.dropzone__icon {
  font-size: 17px;
  color: var(--accent-2);
}

.dropzone__icon--hero { font-size: 30px; }

.dropzone__title {
  font-family: "Space Grotesk", sans-serif;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}

.dropzone__hint {
  font-size: 13px;
  color: var(--text-muted);
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

.latency-note {
  margin-top: 10px;
  font-size: 12.5px;
  font-family: "IBM Plex Mono", monospace;
  color: var(--accent-2);
  text-align: center;
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
  .dropzone, .card, .pill, .btn-export, .btn-plan, .feature-card, .study-day { transition: none !important; }
}

.banner {
  margin-top: 12px;
  padding: 11px 16px;
  border-radius: 8px;
  font-size: 13.5px;
  background: var(--high-soft);
  border: 1px solid rgba(129, 140, 248, 0.3);
  color: #c7d2fe;
  width: 100%;
  max-width: 640px;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  width: 100%;
  max-width: 960px;
  margin-top: 36px;
}

.feature-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px 20px;
  text-align: center;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.feature-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-3px);
}

.feature-card__icon {
  font-size: 22px;
  display: block;
  margin-bottom: 10px;
}

.feature-card__title {
  font-family: "Space Grotesk", sans-serif;
  font-size: 14.5px;
  font-weight: 600;
  margin: 0 0 6px;
}

.feature-card__desc {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.heatmap-banner {
  margin-top: 12px;
  padding: 11px 16px;
  border-radius: 8px;
  font-size: 13px;
  background: var(--medium-soft);
  border: 1px solid rgba(34, 211, 238, 0.25);
  color: #a5f3fc;
}

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
  flex-wrap: wrap;
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

.btn-export,
.btn-plan {
  flex-shrink: 0;
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-family: "Space Grotesk", sans-serif;
  font-size: 13.5px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s ease, filter 0.15s ease;
  white-space: nowrap;
}

.btn-export {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #06060a;
  box-shadow: 0 6px 18px var(--accent-glow);
}

.btn-export:hover { transform: translateY(-1px); filter: brightness(1.05); }
.btn-export:active { transform: translateY(0); }

.btn-plan {
  background: var(--surface-raised);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-plan:hover:not(:disabled) { border-color: var(--accent-2); color: var(--accent-2); }
.btn-plan:disabled { opacity: 0.6; cursor: default; }

.study-panel {
  margin-top: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.study-panel__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  color: var(--text-muted);
  padding: 8px 4px;
}

.study-panel__empty {
  font-size: 13.5px;
  color: var(--text-muted);
  margin: 4px;
}

.study-panel__row {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.study-panel__note {
  margin: 12px 4px 0;
  font-size: 12px;
  color: var(--text-muted);
}

.study-day {
  flex: 0 0 200px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
}

.study-day__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.study-day__date {
  font-family: "Space Grotesk", sans-serif;
  font-size: 12.5px;
  font-weight: 600;
}

.study-day__hours {
  font-family: "IBM Plex Mono", monospace;
  font-size: 11px;
  color: var(--text-muted);
}

.study-day__bar {
  height: 4px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
  margin-bottom: 10px;
}

.study-day__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.study-day__blocks {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.study-block {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

.study-block__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.study-block__hours {
  font-family: "IBM Plex Mono", monospace;
  color: var(--text-muted);
  flex-shrink: 0;
}

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

.empty-state {
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
  margin-top: 40px;
}

@media (max-width: 900px) {
  .feature-grid { grid-template-columns: 1fr; max-width: 420px; }
}

@media (max-width: 720px) {
  .header--hero .header__titles h1 { font-size: 2.4rem; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .toolbar__metrics { justify-content: space-between; }
  .controls-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .controls__count { text-align: right; }
  .app { padding: 32px 18px 64px; }
  .study-day { flex: 0 0 160px; }
}
`;