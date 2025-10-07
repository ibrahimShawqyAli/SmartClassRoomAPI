// routes/attendance.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

router.post("/check", auth, async (req, res) => {
  try {
    const { offering_id, action, modulation_string, udid, now_ts } = req.body;

    if (!offering_id || !action || !modulation_string) {
      return res.status(400).json({
        status: false,
        error: "offering_id, action, modulation_string required",
      });
    }
    if (!["checkin", "checkout"].includes(action)) {
      return res.status(400).json({
        status: false,
        error: "action must be 'checkin' or 'checkout'",
      });
    }

    // 1) Offering exists? (and optional modulation_string check if column exists)
    let hasModulationCol = false;
    try {
      const col = await query(
        `SELECT COL_LENGTH('dbo.course_offerings', 'modulation_string') AS hasCol`
      );
      hasModulationCol =
        !!col.recordset?.[0] && col.recordset[0].hasCol !== null;
    } catch {
      /* ignore */
    }

    const off = await query(
      hasModulationCol
        ? `SELECT id, modulation_string FROM dbo.course_offerings WHERE id=@p0`
        : `SELECT id FROM dbo.course_offerings WHERE id=@p0`,
      [offering_id]
    );
    if (!off.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }
    if (hasModulationCol) {
      const expected = off.recordset[0].modulation_string;
      if (expected && expected !== modulation_string) {
        return res
          .status(400)
          .json({ status: false, error: "Modulation mismatch" });
      }
    }

    // 2) User assigned? (unless admin)
    const asg = await query(
      `SELECT role FROM dbo.offering_assignments WHERE offering_id=@p0 AND user_id=@p1`,
      [offering_id, req.user.id]
    );
    if (!asg.recordset.length && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "User not assigned to this offering" });
    }

    // 3) Pick session for "now" with fallbacks depending on available columns
    const nowIso = (now_ts ? new Date(now_ts) : new Date()).toISOString();

    // Detect columns on dbo.course_sessions
    const cols = await query(`
      SELECT
        COL_LENGTH('dbo.course_sessions','planned_date') AS has_planned_date,
        COL_LENGTH('dbo.course_sessions','planned_start_time') AS has_planned_start_time,
        COL_LENGTH('dbo.course_sessions','planned_end_time') AS has_planned_end_time,
        COL_LENGTH('dbo.course_sessions','started_at') AS has_started_at,
        COL_LENGTH('dbo.course_sessions','ended_at') AS has_ended_at
    `);

    const C = cols.recordset[0] || {};
    const hasPlanned =
      C.has_planned_date !== null && C.has_planned_start_time !== null;

    let sess, sessSql, params;

    if (action === "checkin") {
      if (hasPlanned) {
        // Original “today” logic using planned_* if present
        sessSql = `
          SELECT TOP 1 id, status
          FROM dbo.course_sessions
          WHERE offering_id=@p0
            AND planned_date = CONVERT(date, @p1)
            AND status='started'
          ORDER BY
            ISNULL(started_at,
                   DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_start_time), CAST(planned_date AS DATETIME2))
            ) DESC,
            id DESC
        `;
        params = [offering_id, nowIso];
      } else {
        // Fallback: latest STARTED session for this offering (no planned_* columns)
        sessSql = `
          SELECT TOP 1 id, status
          FROM dbo.course_sessions
          WHERE offering_id=@p0 AND status='started'
          ORDER BY
            CASE WHEN ${
              C.has_started_at !== null ? "started_at" : "id"
            } IS NULL THEN 1 ELSE 0 END,
            ${C.has_started_at !== null ? "started_at DESC," : ""}
            id DESC
        `;
        params = [offering_id];
      }
      sess = await query(sessSql, params);
    } else {
      // checkout: prefer STARTED else most recent ENDED (today if we can; else latest)
      if (hasPlanned) {
        sessSql = `
          SELECT TOP 1 id, status
          FROM dbo.course_sessions
          WHERE offering_id=@p0
            AND planned_date = CONVERT(date, @p1)
            AND status IN ('started','ended')
          ORDER BY
            CASE WHEN status='started' THEN 1 ELSE 2 END,
            ISNULL(started_at,
                   DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_start_time), CAST(planned_date AS DATETIME2))
            ) DESC,
            ISNULL(ended_at,
                   DATEADD(SECOND, DATEDIFF(SECOND, 0, planned_end_time), CAST(planned_date AS DATETIME2))
            ) DESC,
            id DESC
        `;
        params = [offering_id, nowIso];
      } else {
        sessSql = `
          SELECT TOP 1 id, status
          FROM dbo.course_sessions
          WHERE offering_id=@p0 AND status IN ('started','ended')
          ORDER BY
            CASE WHEN status='started' THEN 1 ELSE 2 END,
            ${
              C.has_started_at !== null
                ? "ISNULL(started_at, '1900-01-01') DESC,"
                : ""
            }
            ${
              C.has_ended_at !== null
                ? "ISNULL(ended_at,   '1900-01-01') DESC,"
                : ""
            }
            id DESC
        `;
        params = [offering_id];
      }
      sess = await query(sessSql, params);
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

    // 4) Write attendance (first-in, last-out)
    const upsertSql =
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

    await query(upsertSql, [
      session_id,
      req.user.id,
      modulation_string,
      udid || null,
    ]);

    // 5) Notify teachers (offering room)
    const io = req.app.get("io");
    if (io) {
      io.to(`off:${offering_id}:teachers`).emit("attendance_updated", {
        offering_id,
        session_id,
        user_id: req.user.id,
        action,
        at: new Date().toISOString(),
      });
    }

    return res.json({ status: true, offering_id, session_id, action });
  } catch (e) {
    console.error("attendance check error:", e);
    return res.status(500).json({ status: false, error: "Attendance failed" });
  }
});

module.exports = router;
