// dashboard_routes/timetable.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const { getReqUser } = require("../helpers/authUtils");

/**
 * GET /dashboard/timetable/my-week
 * Query:
 *   from?=2025-11-02T00:00:00Z  -> week anchor (any day inside the week). Defaults to "now" (UTC).
 *   course_id?=number
 *   department_id?=number
 *   level_id?=number
 *
 * Returns:
 * {
 *   status:true,
 *   week_start_utc: "2025-11-02T00:00:00.000Z",
 *   week_end_utc:   "2025-11-09T00:00:00.000Z",
 *   week_lectures: [
 *     { course_id, start_time, end_time, room_id, day_of_week }
 *   ]
 * }
 */
router.post("/my-week", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);

    const fromRaw = (req.query.from || "").trim();
    const courseId = req.query.course_id ? Number(req.query.course_id) : null;
    const departmentId = req.query.department_id
      ? Number(req.query.department_id)
      : null;
    const levelId = req.query.level_id ? Number(req.query.level_id) : null;

    // --- Compute week [start, end) in UTC (week starts on Sunday=0)
    const now = new Date();
    const anchor = fromRaw ? new Date(fromRaw) : now;
    if (isNaN(anchor.getTime())) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid 'from' date" });
    }
    const day = anchor.getUTCDay(); // 0..6 (Sun..Sat)
    const weekStart = new Date(
      Date.UTC(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth(),
        anchor.getUTCDate()
      )
    );
    weekStart.setUTCDate(weekStart.getUTCDate() - day); // go back to Sunday
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

    // --- Check if new assignments table exists
    const hasNew = await query(
      "SELECT 1 AS ok FROM sys.objects WHERE name='offering_assignments' AND type='U'"
    );
    const useNewAssign = !!hasNew.recordset.length;

    // --- Build offerings filter (permission + optional filters)
    const offFilters = [];
    const offParams = [];

    if (courseId != null && Number.isFinite(courseId)) {
      offFilters.push("o.course_id = @p" + offParams.length);
      offParams.push(courseId);
    }
    if (departmentId != null && Number.isFinite(departmentId)) {
      offFilters.push("o.department_id = @p" + offParams.length);
      offParams.push(departmentId);
    }
    if (levelId != null && Number.isFinite(levelId)) {
      offFilters.push("o.level_id = @p" + offParams.length);
      offParams.push(levelId);
    }

    if (role !== "admin") {
      if (useNewAssign) {
        offFilters.push(
          `EXISTS (SELECT 1 FROM dbo.offering_assignments oa WHERE oa.offering_id = o.id AND oa.user_id = @p${offParams.length})`
        );
        offParams.push(userId);
      } else {
        offFilters.push(
          `EXISTS (
             SELECT 1
               FROM dbo.map_lecture_offering M
               JOIN dbo.lecture_assignments A ON A.lecture_id = M.lecture_id
              WHERE M.offering_id = o.id AND A.user_id = @p${offParams.length}
           )`
        );
        offParams.push(userId);
      }
    }

    const offeringsWhere = offFilters.length
      ? "WHERE " + offFilters.join(" AND ")
      : "";

    // --- Sessions inside this week [start, end)
    const sql = `
      WITH offerings AS (
        SELECT
          o.id           AS offering_id,
          o.course_id,
          o.room_id      AS default_room_id,   -- optional fallback
          o.level_id,
          o.department_id,
          o.term_id
        FROM dbo.offerings o
        ${offeringsWhere}
      ),
      base AS (
        SELECT
          s.id,
          s.offering_id,
          s.planned_start_utc,
          s.planned_end_utc,
          ofr.course_id,
          ofr.level_id,
          ofr.department_id,
          ofr.term_id
        FROM dbo.course_sessions s
        JOIN offerings ofr ON ofr.offering_id = s.offering_id
        WHERE s.planned_start_utc >= @p${offParams.length}
          AND s.planned_start_utc <  @p${offParams.length + 1}
      )
      SELECT
        b.course_id,
        CONVERT(varchar(33), b.planned_start_utc, 127) AS start_time, -- ISO 8601
        CONVERT(varchar(33), b.planned_end_utc,   127) AS end_time,   -- ISO 8601
        COALESCE(sr.room_id, o.room_id, r.id) AS room_id,             -- try session_room link if you have; fallbacks
        ((DATEPART(WEEKDAY, b.planned_start_utc) + 6) % 7) AS day_of_week
      FROM base b
      LEFT JOIN dbo.rooms r ON 1 = 0             -- keep structure; real room resolved below if you store per-session room
      LEFT JOIN dbo.offerings o ON o.id = b.offering_id
      OUTER APPLY (
        -- If you store per-session room in another table, resolve it here; else this returns NULL
        SELECT NULL AS room_id
      ) AS sr
      ORDER BY b.planned_start_utc ASC, b.offering_id ASC, b.id ASC;
    `;

    const resDb = await query(sql, [
      ...offParams,
      weekStart.toISOString(),
      weekEnd.toISOString(),
    ]);

    return res.json({
      status: true,
      week_start_utc: weekStart.toISOString(),
      week_end_utc: weekEnd.toISOString(),
      week_lectures: resDb.recordset.map((row) => ({
        course_id: row.course_id,
        start_time: row.start_time,
        end_time: row.end_time,
        room_id: row.room_id ?? null,
        day_of_week: Number(row.day_of_week),
      })),
    });
  } catch (err) {
    console.error("timetable my-week error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to build timetable" });
  }
});

module.exports = router;
