// dashboard_routes/offerings.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const db = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const { TYPES } = db;

function requireAdmin(req, res, next) {
  const role = (req.user?.role || "").toLowerCase();
  if (role !== "admin")
    return res.status(403).json({ status: false, error: "Admin only" });
  next();
}

// small helper
async function one(sql, params = []) {
  const r = await query(sql, params);
  return r.recordset[0] || null;
}

// validate FK if value provided (allows NULL)
async function mustExistIfProvided({ table, id, field = "id", label }) {
  if (id === undefined || id === null) return null; // status to be null
  const row = await one(`SELECT ${field} FROM ${table} WHERE ${field}=@p0`, [
    id,
  ]);
  if (!row) throw new Error(`invalid_${label}`);
  return id;
}

const OFFERINGS_TABLE = "course_offerings";

/* ----------------- Helper: normalize time ----------------- */
function normalizeTimeToHMS(input) {
  if (input == null) throw new Error("Invalid time");
  let s = String(input).trim().toUpperCase();

  // accept "10", "10:30", "10 AM", "10.30", "10-30"
  s = s.replace(/\./g, ":").replace(/-/g, ":");

  const ampmMatch = s.match(/\b(AM|PM)\b/);
  const ampm = ampmMatch ? ampmMatch[1] : null;
  s = s.replace(/\b(AM|PM)\b/, "").trim();

  const parts = s
    .split(":")
    .map((x) => x.trim())
    .filter(Boolean);
  let h = 0,
    m = 0,
    sec = 0;

  if (parts.length === 1) {
    h = parseInt(parts[0], 10);
  } else if (parts.length === 2) {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
  } else {
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
    sec = parseInt(parts[2] || "0", 10);
  }

  if ([h, m, sec].some(Number.isNaN)) throw new Error("Invalid time");
  if (ampm === "AM" && h === 12) h = 0;
  if (ampm === "PM" && h < 12) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59)
    throw new Error("Invalid time");

  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/* ============================================================
   POST /api/offerings/schedule
   ============================================================ */
router.post("/schedule", auth, requireAdmin, async (req, res) => {
  try {
    const {
      courseCode,
      courseName,
      departmentId = null,
      creditHours = null,
      roomId,
      dayOfWeek, // 0..6
      startTime,
      endTime,
      termId = null,
      sectionId = null,
      groupId = null,
    } = req.body || {};

    // Validation
    if (
      !courseCode ||
      !courseName ||
      roomId == null ||
      dayOfWeek == null ||
      !startTime ||
      !endTime
    ) {
      return res.status(400).json({
        status: false,
        error:
          "courseCode, courseName, roomId, dayOfWeek, startTime, endTime are required",
      });
    }

    // Normalize
    const code = String(courseCode).trim().toUpperCase();
    const name = String(courseName).trim();
    const startHMS = normalizeTimeToHMS(startTime);
    const endHMS = normalizeTimeToHMS(endTime);

    // Call the stored procedure
    const result = await db.execProc(
      "dbo.CourseOffering_CreateIfFree",
      {
        CourseCode: code,
        CourseName: name,
        DepartmentId: departmentId == null ? null : Number(departmentId), // 👈
        CreditHours: creditHours == null ? null : Number(creditHours), // 👈
        RoomId: Number(roomId),
        DayOfWeek: Number(dayOfWeek),
        StartTime: startHMS,
        EndTime: endHMS,
        TermId: termId == null ? null : Number(termId),
        SectionId: sectionId == null ? null : Number(sectionId),
        GroupId: groupId == null ? null : Number(groupId),
        CourseId: 0,
        OfferingId: 0,
      },
      {
        CourseCode: db.TYPES.NVarChar,
        CourseName: db.TYPES.NVarChar,
        DepartmentId: db.TYPES.Int,
        CreditHours: db.TYPES.Int,
        RoomId: db.TYPES.Int,
        DayOfWeek: db.TYPES.TinyInt,
        StartTime: db.TYPES.NVarChar,
        EndTime: db.TYPES.NVarChar,
        TermId: db.TYPES.Int,
        SectionId: db.TYPES.Int,
        GroupId: db.TYPES.Int,
        CourseId: db.TYPES.Int,
        OfferingId: db.TYPES.Int,
      }
    );

    // Helper to format time
    const toHHMM = (v) => {
      if (v == null) return v;
      const s = String(v);
      if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 5);
      try {
        return new Date(v).toISOString().substring(11, 16);
      } catch {
        return s;
      }
    };

    // Massage row before response
    const row = result.recordset?.[0] || null;
    if (row) {
      row.start_time = toHHMM(row.start_time);
      row.end_time = toHHMM(row.end_time);
      row.department_id = departmentId;
      row.credit_hours = creditHours;
    }

    return res.status(201).json({
      status: true,
      courseId: result.output.CourseId,
      offeringId: result.output.OfferingId,
      offering: row,
    });
  } catch (err) {
    const num = err?.originalError?.info?.number || err?.number;

    if (num === 50020)
      return res.status(400).json({ status: false, error: "Room not found" });
    if (num === 50021)
      return res.status(400).json({ status: false, error: "Term not found" });
    if (num === 50022)
      return res
        .status(400)
        .json({ status: false, error: "Section not found" });
    if (num === 50023)
      return res.status(400).json({ status: false, error: "Group not found" });
    if (num === 50024)
      return res
        .status(400)
        .json({ status: false, error: "Course could not be created/resolved" });
    if (num === 50002) {
      return res
        .status(409)
        .json({ status: false, error: "Room/time slot is already taken" });
    }
    if (num === 50010) {
      return res
        .status(400)
        .json({ status: false, error: "StartTime must be before EndTime" });
    }
    if (num === 50011) {
      return res.status(400).json({
        status: false,
        error: "Invalid time format; expected HH:MM[:SS]",
      });
    }

    console.error("schedule offering error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/* =========================
   GET /api/offerings (paginated, minimal fields)
   ========================= */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize || "20", 10), 1),
      100
    );
    const search = (req.query.search || "").trim();

    const where = search ? "WHERE c.code LIKE @p0 OR c.name LIKE @p1" : "";
    const countParams = search ? [`%${search}%`, `%${search}%`] : [];

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.${OFFERINGS_TABLE} o
      JOIN dbo.courses c ON c.id = o.course_id
      ${where};
    `;
    const total = (await query(countSql, countParams)).recordset[0].total;

    const offset = (page - 1) * pageSize;
    const dataParams = search
      ? [`%${search}%`, `%${search}%`, offset, pageSize]
      : [offset, pageSize];

    const dataSql = `
      SELECT 
        o.id                     AS offering_id,
        c.id                     AS course_id,
        c.code                   AS course_code,
        c.name                   AS course_name,
        c.department_id,
        c.credit_hours,
        o.primary_room_id        AS room_id,
        r.name                   AS room_name,
        o.day_of_week,
        CONVERT(varchar(5), o.start_time, 108) AS start_time, -- HH:MM
        CONVERT(varchar(5), o.end_time, 108)   AS end_time,
        o.duration_minutes,
        o.term_id,
        t.name                   AS term_name,
        o.section_id,
        s.name                   AS section_name,
        o.group_id,
        g.name                   AS group_name,
        o.created_at
      FROM dbo.${OFFERINGS_TABLE} o
      JOIN dbo.courses c    ON c.id = o.course_id
      LEFT JOIN dbo.rooms r ON r.id = o.primary_room_id
      LEFT JOIN dbo.terms t ON t.id = o.term_id
      LEFT JOIN dbo.sections s ON s.id = o.section_id
      LEFT JOIN dbo.[groups] g ON g.id = o.group_id
      ${where}
      ORDER BY o.id DESC
      OFFSET @p${search ? 2 : 0} ROWS FETCH NEXT @p${search ? 3 : 1} ROWS ONLY;
    `;
    const rows = (await query(dataSql, dataParams)).recordset || [];

    return res.json({
      status: true,
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
      data: rows,
    });
  } catch (err) {
    console.error("List offerings error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/offerings
 */
router.get("/", auth, requireAdmin, async (_req, res) => {
  try {
    const r = await query(`
      SELECT o.id, c.name AS course_name, o.term_id, o.section_id, o.group_id,
             o.primary_room_id, o.day_of_week,
             CONVERT(varchar(8), o.start_time, 108) AS start_time,
             CONVERT(varchar(8), o.end_time,   108) AS end_time,
             o.duration_minutes,
             t.name AS term_name, s.name AS section_name, g.name AS group_name, r.name AS room_name
      FROM dbo.course_offerings o
      JOIN dbo.courses c       ON c.id = o.course_id
      LEFT JOIN dbo.terms t    ON t.id = o.term_id
      LEFT JOIN dbo.sections s ON s.id = o.section_id
      LEFT JOIN dbo.groups g   ON g.id = o.group_id
      LEFT JOIN dbo.rooms  r   ON r.id = o.primary_room_id
      ORDER BY c.name, o.day_of_week, o.start_time, o.id
    `);
    res.json({ status: true, offerings: r.recordset });
  } catch (e) {
    console.error("List offerings error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * POST /dashboard/offerings
 * Body: {
 *   course_id, term_id?, section_id?, group_id?, primary_room_id?,
 *   day_of_week, start_time("HH:mm" or "HH:mm:ss"), end_time?("HH:mm[:ss]"), duration_minutes?
 * }
 * Either end_time OR duration_minutes is required.
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const {
      course_id,
      term_id,
      section_id,
      group_id,
      primary_room_id,
      day_of_week,
      start_time,
      end_time,
      duration_minutes,
    } = req.body || {};

    // --- basic required fields
    if (!course_id)
      return res
        .status(400)
        .json({ status: false, error: "course_id is required" });
    if (day_of_week === undefined || day_of_week === null)
      return res
        .status(400)
        .json({ status: false, error: "day_of_week is required" });
    if (!start_time)
      return res
        .status(400)
        .json({ status: false, error: "start_time is required" });
    if (!end_time && !duration_minutes)
      return res
        .status(400)
        .json({ status: false, error: "Provide end_time or duration_minutes" });

    // --- validate FKs
    const courseOk = await mustExistIfProvided({
      table: "dbo.courses",
      id: course_id,
      label: "course_id",
    });
    const termOk = await mustExistIfProvided({
      table: "dbo.terms",
      id: term_id,
      label: "term_id",
    });
    const sectionOk = await mustExistIfProvided({
      table: "dbo.sections",
      id: section_id,
      label: "section_id",
    });
    const groupOk = await mustExistIfProvided({
      table: "dbo.groups",
      id: group_id,
      label: "group_id",
    });
    const roomOk = await mustExistIfProvided({
      table: "dbo.rooms",
      id: primary_room_id,
      label: "primary_room_id",
    });

    // --- normalize time strings
    const startStr = /^\d{2}:\d{2}$/.test(String(start_time))
      ? `${start_time}:00`
      : String(start_time);
    const endStr = end_time
      ? /^\d{2}:\d{2}$/.test(String(end_time))
        ? `${end_time}:00`
        : String(end_time)
      : null;
    const dow = Number(day_of_week);
    const dur = duration_minutes != null ? Number(duration_minutes) : null;
    if (Number.isNaN(dow) || dow < 0 || dow > 6) {
      return res
        .status(400)
        .json({ status: false, error: "day_of_week must be 0..6" });
    }
    if (dur != null && (Number.isNaN(dur) || dur <= 0 || dur > 600)) {
      return res
        .status(400)
        .json({ status: false, error: "duration_minutes must be 1..600" });
    }

    // --- compute @end TIME and conflict-check if room provided
    const sql = `
      DECLARE @start TIME(0) = @p0;
      DECLARE @end   TIME(0) = ${
        endStr ? "@p1" : "CONVERT(TIME(0), DATEADD(MINUTE, @p2, @start))"
      };

      -- room conflict (only when a room is chosen)
      IF @p3 IS NOT NULL
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM dbo.course_offerings WITH (UPDLOCK, HOLDLOCK)
          WHERE primary_room_id = @p3
            AND day_of_week     = @p4
            AND start_time < @end
            AND end_time   > @start
        )
        BEGIN
          SELECT CAST(1 AS BIT) AS conflict; RETURN;
        END
      END

      INSERT INTO dbo.course_offerings
        (course_id, term_id, section_id, group_id, primary_room_id,
         day_of_week, start_time, end_time, duration_minutes, created_at)
      OUTPUT INSERTED.id
      VALUES
        (@p5, @p6, @p7, @p8, @p3,
         @p4, @start, @end, @p2, SYSUTCDATETIME());
    `;

    // params order matches the SQL above
    const params = [
      startStr, // @p0
      endStr, // @p1 (may be null not used in compute branch)
      dur, // @p2
      roomOk, // @p3
      dow, // @p4
      courseOk, // @p5
      termOk, // @p6 (can be null)
      sectionOk, // @p7 (can be null)
      groupOk, // @p8 (can be null)
    ];

    const r = await query(sql, params);
    if (r.recordset?.[0]?.conflict) {
      return res
        .status(409)
        .json({ status: false, error: "Room already booked at this day/time" });
    }

    return res.json({ status: true, offering_id: r.recordset[0].id });
  } catch (e) {
    // friendly FK errors
    if (e.message && e.message.startsWith("invalid_")) {
      return res.status(400).json({
        status: false,
        error: `Unknown ${e.message.replace("invalid_", "")}`,
      });
    }
    if (e.number === 547) {
      // generic SQL FK violation fallback
      return res.status(400).json({
        status: false,
        error: "Invalid foreign key (term/section/group/room)",
      });
    }
    console.error("Create offering error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * PATCH /dashboard/offerings/:id
 * Same validation + avoid overlap (excluding current row)
 */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exists = await one(
      `SELECT id FROM dbo.course_offerings WHERE id=@p0`,
      [id]
    );
    if (!exists)
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });

    const {
      term_id,
      section_id,
      group_id,
      primary_room_id,
      day_of_week,
      start_time,
      end_time,
      duration_minutes,
    } = req.body || {};

    // normalize/validate inputs (optional updates)
    const startStr = start_time
      ? /^\d{2}:\d{2}$/.test(String(start_time))
        ? `${start_time}:00`
        : String(start_time)
      : null;
    const endStr = end_time
      ? /^\d{2}:\d{2}$/.test(String(end_time))
        ? `${end_time}:00`
        : String(end_time)
      : null;
    const dow = day_of_week != null ? Number(day_of_week) : null;
    const dur = duration_minutes != null ? Number(duration_minutes) : null;
    if (dow != null && (Number.isNaN(dow) || dow < 0 || dow > 6))
      return res
        .status(400)
        .json({ status: false, error: "day_of_week must be 0..6" });
    if (dur != null && (Number.isNaN(dur) || dur <= 0 || dur > 600))
      return res
        .status(400)
        .json({ status: false, error: "duration_minutes must be 1..600" });

    // validate FKs if provided
    const termOk = await mustExistIfProvided({
      table: "dbo.terms",
      id: term_id,
      label: "term_id",
    });
    const sectionOk = await mustExistIfProvided({
      table: "dbo.sections",
      id: section_id,
      label: "section_id",
    });
    const groupOk = await mustExistIfProvided({
      table: "dbo.groups",
      id: group_id,
      label: "group_id",
    });
    const roomOk = await mustExistIfProvided({
      table: "dbo.rooms",
      id: primary_room_id,
      label: "primary_room_id",
    });

    // conflict check (build @start/@end from COALESCE of incoming or current row)
    const sql = `
      DECLARE @id INT = @p0;

      DECLARE @cur_day  TINYINT, @cur_start TIME(0), @cur_end TIME(0), @cur_dur INT, @cur_room INT;
      SELECT @cur_day = day_of_week, @cur_start = start_time, @cur_end = end_time,
             @cur_dur = duration_minutes, @cur_room = primary_room_id
      FROM dbo.course_offerings WHERE id=@id;

      DECLARE @day  TINYINT  = COALESCE(@p1, @cur_day);
      DECLARE @start TIME(0) = COALESCE(@p2, @cur_start);
      DECLARE @end   TIME(0) = CASE
                                  WHEN @p3 IS NOT NULL THEN @p3
                                  WHEN @p4 IS NOT NULL THEN CONVERT(TIME(0), DATEADD(MINUTE, @p4, @start))
                                  ELSE @cur_end
                                END;
      DECLARE @room  INT     = COALESCE(@p5, @cur_room);

      IF @room IS NOT NULL
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM dbo.course_offerings
          WHERE primary_room_id=@room
            AND day_of_week=@day
            AND id<>@id
            AND start_time < @end
            AND end_time   > @start
        )
        BEGIN
          SELECT CAST(1 AS BIT) AS conflict; RETURN;
        END
      END

      UPDATE dbo.course_offerings
         SET term_id         = COALESCE(@p6, term_id),
             section_id      = COALESCE(@p7, section_id),
             group_id        = COALESCE(@p8, group_id),
             primary_room_id = COALESCE(@p5, primary_room_id),
             day_of_week     = @day,
             start_time      = @start,
             end_time        = @end,
             duration_minutes= COALESCE(@p4, duration_minutes)
       WHERE id=@id;

      SELECT @@ROWCOUNT AS affected;
    `;

    const params = [
      id, // @p0
      dow, // @p1
      startStr, // @p2
      endStr, // @p3
      dur, // @p4
      roomOk, // @p5
      termOk, // @p6
      sectionOk, // @p7
      groupOk, // @p8
    ];

    const r = await query(sql, params);
    if (r.recordset?.[0]?.conflict)
      return res
        .status(409)
        .json({ status: false, error: "Room already booked at this day/time" });

    return res.json({ status: true, message: "Offering updated" });
  } catch (e) {
    if (e.message && e.message.startsWith("invalid_")) {
      return res.status(400).json({
        status: false,
        error: `Unknown ${e.message.replace("invalid_", "")}`,
      });
    }
    if (e.number === 547)
      return res
        .status(400)
        .json({ status: false, error: "Invalid foreign key" });

    console.error("Update offering error:", e);
    res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
