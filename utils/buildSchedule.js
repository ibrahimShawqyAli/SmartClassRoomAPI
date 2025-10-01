// utils/buildSchedule.js
const { query } = require("../DB/dbConnection");

/**
 * Returns { totals, week } buckets 0..6 using whichever schema is populated:
 *  A) lecture_assignments → lectures
 *  B) offering_assignments → map_lecture_offering → lectures
 *  C) offering_assignments → course_sessions (fallback by upcoming sessions)
 */
async function buildAssignedSchedule(userId) {
  // check which tables exist
  const ex = await query(`
    SELECT
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='lectures' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_lectures,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='lecture_assignments' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_legacy,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='offering_assignments' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_offering_assignments,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='map_lecture_offering' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_map_lecture_offering,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='course_offerings' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_course_offerings,
      CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.objects WHERE name='course_sessions' AND type='U') THEN 1 ELSE 0 END AS BIT) AS has_course_sessions
  `);
  const f = ex.recordset[0] || {};

  // Week buckets
  const week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const pushRow = (r) => {
    const d = String(r.day_of_week ?? 0);
    week[d].push({
      lecture_id: r.lecture_id ?? null,
      name: r.name ?? r.course_name ?? "Session",
      place: r.place ?? r.room_name ?? null,
      start_date: r.start_date ?? r.planned_date ?? null,
      start_time: r.start_time ?? r.planned_time ?? null,
      end_time: r.end_time ?? r.planned_time_end ?? null,
      duration_minutes: r.duration_minutes ?? null,
      role: r.role ?? r.assign_role ?? null,
    });
  };

  // ========== A) legacy: lecture_assignments -> lectures ==========
  if (f.has_legacy && f.has_lectures) {
    const legacy = await query(
      `
      SELECT
        l.day_of_week,
        l.id  AS lecture_id,
        l.name,
        l.place,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,
        CONVERT(VARCHAR(8), l.end_time,   108) AS end_time,
        l.duration_minutes,
        la.role
      FROM dbo.lecture_assignments la
      JOIN dbo.lectures l ON l.id = la.lecture_id
      WHERE la.user_id = @p0
      ORDER BY l.day_of_week, l.start_time, l.place, l.id
      `,
      [userId]
    );
    console.log("[LOGIN SCHEDULE] legacy rows:", legacy.recordset.length);
    if (legacy.recordset.length) {
      for (const r of legacy.recordset) pushRow(r);
      return {
        totals: Object.fromEntries(
          Object.keys(week).map((k) => [k, week[k].length])
        ),
        week,
      };
    }
  } else {
    console.log("[LOGIN SCHEDULE] legacy path not available.");
  }

  // ========== B) hybrid: offering_assignments -> map_lecture_offering -> lectures ==========
  if (
    f.has_offering_assignments &&
    f.has_map_lecture_offering &&
    f.has_lectures
  ) {
    const hybrid = await query(
      `
      SELECT
        l.day_of_week,
        l.id  AS lecture_id,
        l.name,
        l.place,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,
        CONVERT(VARCHAR(8), l.end_time,   108) AS end_time,
        l.duration_minutes,
        oa.role
      FROM dbo.offering_assignments oa
      JOIN dbo.map_lecture_offering m ON m.offering_id = oa.offering_id
      JOIN dbo.lectures l             ON l.id = m.lecture_id
      WHERE oa.user_id = @p0
      ORDER BY l.day_of_week, l.start_time, l.place, l.id
      `,
      [userId]
    );
    console.log("[LOGIN SCHEDULE] hybrid rows:", hybrid.recordset.length);
    if (hybrid.recordset.length) {
      for (const r of hybrid.recordset) pushRow(r);
      return {
        totals: Object.fromEntries(
          Object.keys(week).map((k) => [k, week[k].length])
        ),
        week,
      };
    }
  } else {
    console.log("[LOGIN SCHEDULE] hybrid path not available.");
  }

  // ========== C) sessions fallback: offering_assignments -> course_sessions ==========
  // We synthesize a weekly view from upcoming sessions (e.g., next 14 days)
  if (
    f.has_offering_assignments &&
    f.has_course_offerings &&
    f.has_course_sessions
  ) {
    const sessions = await query(
      `
      ;WITH upcoming AS (
        SELECT TOP 100
          cs.id AS session_id,
          cs.offering_id,
          cs.planned_start_utc,
          DATEADD(MINUTE, 90, cs.planned_start_utc) AS planned_end_utc, -- assume 90m if you don't have duration
          oa.role AS assign_role,
          c.name AS course_name,
          -- derive day_of_week: DATEPART(dw) returns 1..7 (depends on DATEFIRST); normalize to 0..6 as Sun..Sat
          ((DATEPART(dw, cs.planned_start_utc) + 6) % 7) AS day_of_week
        FROM dbo.offering_assignments oa
        JOIN dbo.course_offerings o ON o.id = oa.offering_id
        JOIN dbo.courses c         ON c.id = o.course_id
        JOIN dbo.course_sessions cs ON cs.offering_id = o.id
        WHERE oa.user_id = @p0
          AND cs.planned_start_utc >= DATEADD(DAY, -1, SYSUTCDATETIME())
        ORDER BY cs.planned_start_utc ASC
      )
      SELECT
        day_of_week,
        NULL       AS lecture_id,
        course_name AS name,
        NULL       AS place,
        CAST(planned_start_utc AS DATE)                      AS planned_date,
        CONVERT(VARCHAR(8), CAST(planned_start_utc AS TIME), 108) AS planned_time,
        CONVERT(VARCHAR(8), CAST(planned_end_utc   AS TIME), 108) AS planned_time_end,
        NULL AS duration_minutes,
        assign_role
      FROM upcoming
      `,
      [userId]
    );
    console.log(
      "[LOGIN SCHEDULE] sessions-fallback rows:",
      sessions.recordset.length
    );
    if (sessions.recordset.length) {
      for (const r of sessions.recordset) pushRow(r);
      return {
        totals: Object.fromEntries(
          Object.keys(week).map((k) => [k, week[k].length])
        ),
        week,
      };
    }
  } else {
    console.log("[LOGIN SCHEDULE] sessions-fallback path not available.");
  }

  console.warn("[LOGIN SCHEDULE] no rows from any path for user:", userId);
  return {
    totals: Object.fromEntries(Object.keys(week).map((k) => [k, 0])),
    week,
  };
}

module.exports = { buildAssignedSchedule };
