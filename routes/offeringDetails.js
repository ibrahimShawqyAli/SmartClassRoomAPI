// routes/offeringDetails.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * GET /offering-details?offering_id=123
 */
router.get("/offering-details", auth, async (req, res) => {
  try {
    const offering_id = Number(req.query.offering_id);
    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id is required in query" });
    }

    // 1) Basic offering info (READ FROM course_offerings, not course_sessions)
    const offSql = `
      SELECT
        o.id,
        c.name AS subject_name,
        r.name AS room_name,
        CONVERT(VARCHAR(8), o.start_time, 108) AS start_time,
        CONVERT(VARCHAR(8), o.end_time,   108) AS end_time
      FROM dbo.course_offerings o
      JOIN dbo.courses c          ON c.id = o.course_id
      LEFT JOIN dbo.rooms r       ON r.id = o.primary_room_id
      WHERE o.id = @p0
    `;
    const off = await query(offSql, [offering_id]);
    if (!off.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }
    const O = off.recordset[0];

    // 2) Security: must be assigned OR admin
    if (req.user.role !== "admin") {
      const a = await query(
        `SELECT 1 FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1`,
        [offering_id, req.user.id]
      );
      if (!a.recordset.length) {
        return res
          .status(403)
          .json({ status: false, error: "Not assigned to this offering" });
      }
    }

    // 3) Teachers list
    const teachersSql = `
      SELECT u.id, u.name, u.email
      FROM dbo.offering_assignments oa
      JOIN dbo.users u ON u.id = oa.user_id
      WHERE oa.offering_id=@p0 AND oa.role='teacher'
      ORDER BY u.name
    `;
    const tRes = await query(teachersSql, [offering_id]);

    // 4) Today’s status from course_sessions
    const todaySql = `
      SELECT status
      FROM dbo.course_sessions
      WHERE offering_id=@p0
        AND CAST(planned_start_utc AS DATE) = CAST(SYSUTCDATETIME() AS DATE)
    `;
    const sRes = await query(todaySql, [offering_id]);
    let session_status = "pending";
    if (sRes.recordset.some((r) => r.status === "started")) {
      session_status = "started";
    } else if (sRes.recordset.some((r) => r.status === "ended")) {
      session_status = "ended";
    }

    return res.json({
      status: true,
      offering_id: O.id,
      subject_name: O.subject_name,
      room: O.room_name || null,
      time: {
        start_time: O.start_time || null,
        end_time: O.end_time || null,
      },
      teachers: tRes.recordset,
      session_status,
    });
  } catch (e) {
    console.error("offering-details error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
