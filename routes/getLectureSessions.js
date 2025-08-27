// routes/lectureSessions.js  (append this endpoint)
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * POST /lecture-sessions/list
 * Header: Authorization: Bearer <JWT>
 * Body: { lecture_id }
 *
 * Returns ALL sessions for the given lecture, in UTC:
 * - id, lecture_id
 * - planned_start_utc, planned_end_utc
 * - status ('planned','started','ended','cancelled')
 * - started_at, ended_at
 * - week_index (0..15) relative to the first session
 *
 * Access: user must be assigned to that lecture (student/teacher) or be admin
 */
// routes/lectureSessions.js (replace your /list handler with this)
router.post("/list", auth, async (req, res) => {
  try {
    const { lecture_id } = req.body || {};
    if (!lecture_id) {
      return res
        .status(400)
        .json({ status: false, error: "lecture_id is required" });
    }

    // Check assignment (unless admin)
    if (req.user.role !== "admin") {
      const a = await query(
        `SELECT 1
           FROM dbo.lecture_assignments
          WHERE lecture_id=@p0 AND user_id=@p1`,
        [lecture_id, req.user.id]
      );
      if (!a.recordset.length) {
        return res
          .status(403)
          .json({ status: false, error: "Not assigned to this lecture" });
      }
    }

    // No JOIN — use a CTE to compute UTC start/end once, then window MIN for week_index
    const sql = `
      WITH base AS (
        SELECT
          s.id,
          s.lecture_id,
          DATEADD(SECOND, DATEDIFF(SECOND, 0, s.planned_start_time), CAST(s.planned_date AS DATETIME2)) AS planned_start_utc,
          DATEADD(SECOND, DATEDIFF(SECOND, 0, s.planned_end_time),   CAST(s.planned_date AS DATETIME2)) AS planned_end_utc,
          s.status,
          s.started_at,
          s.ended_at
        FROM dbo.lecture_sessions s
        WHERE s.lecture_id = @p0
      )
      SELECT
        b.*,
        DATEDIFF(
          WEEK,
          MIN(b.planned_start_utc) OVER (PARTITION BY b.lecture_id),
          b.planned_start_utc
        ) AS week_index
      FROM base b
      ORDER BY b.planned_start_utc ASC, b.id ASC;
    `;

    const r = await query(sql, [lecture_id]);

    return res.json({
      status: true,
      count: r.recordset.length,
      sessions: r.recordset.map((row) => ({
        id: row.id,
        lecture_id: row.lecture_id,
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
      .json({ status: false, error: "Failed to fetch lecture sessions" });
  }
});

module.exports = router;
