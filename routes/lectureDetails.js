// routes/lectureDetails.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * GET /lecture-details?lecture_id=123
 * Header: Authorization: Bearer <JWT>
 *
 * Response:
 * {
 *   status: true,
 *   lecture_id: 1,
 *   lecture_name: "Signals & Systems",
 *   time: { start_time: "10:00:00", end_time: "11:30:00" },
 *   teachers: [{ id, name, email }, ...],
 *   lecture_status: "started" | "ended" | "pending"
 * }
 */
router.get("/lecture-details", auth, async (req, res) => {
  try {
    const lecture_id = Number(req.query.lecture_id);
    if (!lecture_id) {
      return res
        .status(400)
        .json({ status: false, error: "lecture_id is required in query" });
    }

    // 1) Basic lecture info (name + times)
    // If you have a persisted end_time column, we can select it directly.
    // If not, uncomment the DATEADD version below.
    const lecSql = `
      SELECT
        l.id,
        l.name,
        l.place,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,
        CONVERT(VARCHAR(8), l.end_time,   108) AS end_time
        -- If you DON'T have end_time column, use this instead:
        -- CONVERT(VARCHAR(8), DATEADD(MINUTE, l.duration_minutes, l.start_time), 108) AS end_time
      FROM dbo.lectures l
      WHERE l.id = @p0
    `;
    const lec = await query(lecSql, [lecture_id]);
    if (!lec.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });
    }
    const L = lec.recordset[0];

    // 2) Security: must be assigned OR admin
    if (req.user.role !== "admin") {
      const a = await query(
        `SELECT 1 FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1`,
        [lecture_id, req.user.id]
      );
      if (!a.recordset.length) {
        return res
          .status(403)
          .json({ status: false, error: "Not assigned to this lecture" });
      }
    }

    // 3) Teachers list (could be multiple)
    const teachersSql = `
      SELECT u.id, u.name, u.email
      FROM dbo.lecture_assignments la
      JOIN dbo.users u ON u.id = la.user_id
      WHERE la.lecture_id=@p0 AND la.role='teacher'
      ORDER BY u.name
    `;
    const tRes = await query(teachersSql, [lecture_id]);
    const teachers = tRes.recordset;

    // 4) Today’s status from lecture_sessions
    // Priority: if any 'started' today -> "started"
    // else if any 'ended' today -> "ended"
    // else -> "pending"
    const todaySql = `
      SELECT status
      FROM dbo.lecture_sessions
      WHERE lecture_id = @p0
        AND planned_date = CAST(SYSUTCDATETIME() AS DATE)
    `;
    const sRes = await query(todaySql, [lecture_id]);
    let lecture_status = "pending";
    if (sRes.recordset.some((r) => r.status === "started")) {
      lecture_status = "started";
    } else if (sRes.recordset.some((r) => r.status === "ended")) {
      lecture_status = "ended";
    }

    return res.json({
      status: true,
      lecture_id: L.id,
      lecture_name: L.name,
      lecture_place: L.place,
      time: {
        start_time: L.start_time, // "HH:mm:ss"
        end_time: L.end_time, // "HH:mm:ss"
      },
      teachers,
      lecture_status,
    });
  } catch (e) {
    console.error("lecture-details error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
