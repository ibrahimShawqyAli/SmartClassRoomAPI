// routes/attendance.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * POST /attendance/check
 * Body: {
 *   lecture_id: number,
 *   action: "checkin" | "checkout",
 *   modulation_string: string,
 *   udid?: string,
 *   now_ts?: ISO string (optional, for testing)
 * }
 */
router.post("/check", auth, async (req, res) => {
  try {
    const { lecture_id, action, modulation_string, udid, now_ts } = req.body;

    if (!lecture_id || !action || !modulation_string) {
      return res.status(400).json({
        status: false,
        error: "lecture_id, action, modulation_string required",
      });
    }
    if (!["checkin", "checkout"].includes(action)) {
      return res.status(400).json({
        status: false,
        error: "action must be 'checkin' or 'checkout'",
      });
    }

    // 1) lecture + modulation
    const lec = await query(
      "SELECT id, modulation_string FROM dbo.lectures WHERE id=@p0",
      [lecture_id]
    );
    if (!lec.recordset.length)
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });

    const lect = lec.recordset[0];
    if (
      lect.modulation_string &&
      lect.modulation_string !== modulation_string
    ) {
      return res
        .status(400)
        .json({ status: false, error: "Modulation mismatch" });
    }

    // 2) assigned?
    const asg = await query(
      "SELECT role FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1",
      [lecture_id, req.user.id]
    );
    if (!asg.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "User not assigned to this lecture" });
    }

    // 3) choose the correct session for today
    const today = (now_ts ? new Date(now_ts) : new Date())
      .toISOString()
      .slice(0, 10);

    // For check-in: require a STARTED session; pick the latest one
    let sessSql = `
  SELECT TOP 1 id, status
  FROM dbo.lecture_sessions
  WHERE lecture_id=@p0 AND planned_date=@p1 AND status='started'
  ORDER BY
    ISNULL(started_at,
           DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_start_time), CAST(planned_date AS DATETIME2))
    ) DESC,
    id DESC
`;
    let sess = await query(sessSql, [lecture_id, today]);

    // For checkout: prefer a STARTED session; if none, fall back to most recent ENDED today
    if (action === "checkout" && !sess.recordset.length) {
      sessSql = `
    SELECT TOP 1 id, status
    FROM dbo.lecture_sessions
    WHERE lecture_id=@p0 AND planned_date=@p1 AND status IN ('started','ended')
    ORDER BY
      CASE WHEN status='started' THEN 1 ELSE 2 END, -- started first
      ISNULL(started_at,
             DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_start_time), CAST(planned_date AS DATETIME2))
      ) DESC,
      ISNULL(ended_at,
             DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_end_time), CAST(planned_date AS DATETIME2))
      ) DESC,
      id DESC
  `;
      sess = await query(sessSql, [lecture_id, today]);
    }

    if (!sess.recordset.length) {
      return res.status(400).json({
        status: false,
        error:
          action === "checkin"
            ? "No started session available for check-in"
            : "No session available for checkout",
      });
    }

    const session_id = sess.recordset[0].id;

    // 4) write attendance (first in, last out)
    const sql =
      action === "checkin"
        ? `
          IF NOT EXISTS (SELECT 1 FROM dbo.attendance_records WHERE session_id=@p0 AND user_id=@p1)
          BEGIN
            INSERT INTO dbo.attendance_records
              (session_id, user_id, check_in_at, status, [source], modulation_string_seen, udid_at_checkin)
            VALUES (@p0, @p1, SYSUTCDATETIME(), 'present', 'mobile', @p2, @p3);
          END
          ELSE
          BEGIN
            UPDATE dbo.attendance_records
               SET check_in_at = COALESCE(check_in_at, SYSUTCDATETIME())
             WHERE session_id=@p0 AND user_id=@p1;
          END
        `
        : `
          UPDATE dbo.attendance_records
             SET check_out_at =
                   CASE WHEN check_out_at IS NULL OR check_out_at < SYSUTCDATETIME()
                        THEN SYSUTCDATETIME() ELSE check_out_at END
           WHERE session_id=@p0 AND user_id=@p1;

          IF @@ROWCOUNT = 0
          BEGIN
            INSERT INTO dbo.attendance_records
              (session_id, user_id, check_out_at, status, [source], modulation_string_seen, udid_at_checkin)
            VALUES (@p0, @p1, SYSUTCDATETIME(), 'left', 'mobile', @p2, @p3);
          END
        `;

    await query(sql, [
      session_id,
      req.user.id,
      modulation_string,
      udid || null,
    ]);

    // 5) notify teachers (so they see roster updates live)
    const io = req.app.get("io");
    io.to(`lec:${lecture_id}:teachers`).emit("attendance_updated", {
      lecture_id,
      session_id,
      user_id: req.user.id,
      action,
      at: new Date().toISOString(),
    });

    return res.json({ status: true, lecture_id, session_id, action });
  } catch (e) {
    console.error("attendance check error:", e);
    return res.status(500).json({ status: false, error: "Attendance failed" });
  }
});

module.exports = router;
