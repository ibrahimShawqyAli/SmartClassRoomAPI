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

module.exports = router;
