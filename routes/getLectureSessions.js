// routes/lectureSessions.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// Read user from either req.auth (new) or req.user (old)
function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

/**
 * POST /lecture-sessions/list
 * Body: { offering_id }
 *
 * Returns ALL sessions for the given offering (UTC datetimes):
 * - id, offering_id
 * - planned_start_utc, planned_end_utc
 * - status ('planned','started','ended','cancelled')
 * - started_at, ended_at
 * - week_index (0..15) relative to the first planned session
 *
 * Access: user must be assigned to that offering (student/teacher) or be admin
 */
router.post("/list", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);
    const { offering_id } = req.body || {};

    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id is required" });
    }

    // --- Permission check ---
    if (role !== "admin") {
      // Prefer new table offering_assignments; fallback to legacy mapping if needed
      let hasNew = await query(
        "SELECT 1 AS ok FROM sys.objects WHERE name='offering_assignments' AND type='U'"
      );

      let perm;
      if (hasNew.recordset.length) {
        perm = await query(
          `SELECT TOP 1 1
             FROM dbo.offering_assignments
            WHERE offering_id=@p0 AND user_id=@p1`,
          [offering_id, userId]
        );
      } else {
        perm = await query(
          `SELECT TOP 1 1
             FROM dbo.map_lecture_offering M
             JOIN dbo.lecture_assignments A ON A.lecture_id = M.lecture_id
            WHERE M.offering_id=@p0 AND A.user_id=@p1`,
          [offering_id, userId]
        );
      }

      if (!perm.recordset.length) {
        return res
          .status(403)
          .json({ status: false, error: "Not assigned to this offering" });
      }
    }

    // --- Sessions for this offering (NEW: dbo.course_sessions) ---
    const sql = `
      WITH base AS (
        SELECT
          s.id,
          s.offering_id,
          s.planned_start_utc,
          s.planned_end_utc,
          s.status,
          s.started_at,
          s.ended_at
        FROM dbo.course_sessions s
        WHERE s.offering_id = @p0
      )
      SELECT
        b.*,
        DATEDIFF(
          WEEK,
          MIN(b.planned_start_utc) OVER (PARTITION BY b.offering_id),
          b.planned_start_utc
        ) AS week_index
      FROM base b
      ORDER BY b.planned_start_utc ASC, b.id ASC;
    `;

    const r = await query(sql, [offering_id]);

    return res.json({
      status: true,
      count: r.recordset.length,
      sessions: r.recordset.map((row) => ({
        id: row.id,
        offering_id: row.offering_id,
        planned_start_utc: row.planned_start_utc,
        planned_end_utc: row.planned_end_utc,
        status: row.status,
        started_at: row.started_at,
        ended_at: row.ended_at,
        week_index: row.week_index,
      })),
    });
  } catch (e) {
    console.error("list sessions error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch sessions" });
  }
});

// POST /sessions/by-course-id
router.post("/by-course-id", auth, async (req, res) => {
  try {
    const { id: userId, role } = getReqUser(req);
    const { course_id } = req.body || {};

    if (!course_id) {
      return res.status(400).json({
        status: false,
        error: "course_id is required",
      });
    }

    // Use new offering_assignments if present; else legacy mapping
    const hasNew = await query(
      "SELECT 1 AS ok FROM sys.objects WHERE name='offering_assignments' AND type='U'"
    );
    const useNewAssign = !!hasNew.recordset.length;

    // --------- Build offerings filter (course only) + permission for non-admins
    const offFilters = ["o.course_id = @p0"];
    const offParams = [course_id];

    if (role !== "admin") {
      if (useNewAssign) {
        offFilters.push(
          `EXISTS (
             SELECT 1
               FROM dbo.offering_assignments oa
              WHERE oa.offering_id = o.id AND oa.user_id = @p${offParams.length}
           )`
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

    const offeringsWhere = offFilters.join(" AND ");

    // --------- Query: all sessions for these offerings (no date limit)
    const sql = `
      WITH offerings AS (
        SELECT
          o.id           AS offering_id,
          o.course_id,
          o.level_id,
          o.department_id,
          o.term_id,
          o.section,
          o.room_id,
          o.building_id
        FROM dbo.offerings o
        WHERE ${offeringsWhere}
      ),
      base AS (
        SELECT
          s.id,
          s.offering_id,
          s.planned_start_utc,
          s.planned_end_utc,
          s.status,
          s.started_at,
          s.ended_at,
          ofr.course_id,
          ofr.level_id,
          ofr.department_id,
          ofr.term_id,
          ofr.section,
          ofr.room_id,
          ofr.building_id
        FROM dbo.course_sessions s
        JOIN offerings ofr ON ofr.offering_id = s.offering_id
      ),
      enriched AS (
        SELECT
          b.*,
          DATEDIFF(
            WEEK,
            MIN(b.planned_start_utc) OVER (PARTITION BY b.offering_id),
            b.planned_start_utc
          ) AS week_index
        FROM base b
      )
      SELECT
        e.*,
        r.name   AS room_name,
        bld.name AS building_name
      FROM enriched e
      LEFT JOIN dbo.rooms     r   ON r.id   = e.room_id
      LEFT JOIN dbo.buildings bld ON bld.id = e.building_id
      ORDER BY e.planned_start_utc ASC, e.offering_id ASC, e.id ASC;
    `;

    const r = await query(sql, offParams);

    return res.json({
      status: true,
      count: r.recordset.length,
      sessions: r.recordset.map((row) => ({
        id: row.id,
        offering_id: row.offering_id,
        planned_start_utc: row.planned_start_utc,
        planned_end_utc: row.planned_end_utc,
        status: row.status,
        started_at: row.started_at,
        ended_at: row.ended_at,
        week_index: row.week_index,
        // meta
        course_id: row.course_id,
        level_id: row.level_id,
        department_id: row.department_id,
        term_id: row.term_id,
        section: row.section,
        room_id: row.room_id,
        room_name: row.room_name,
        building_name: row.building_name,
      })),
    });
  } catch (e) {
    console.error("by-course-id sessions error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch sessions" });
  }
});

module.exports = router;
