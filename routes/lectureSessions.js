// routes/lectureSessions.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * POST /lecture-sessions/start
 * Body: { lecture_id, modulation_string?, now_ts? }
 */
router.post("/start", auth, async (req, res) => {
  try {
    const { lecture_id, modulation_string, now_ts } = req.body;
    if (!lecture_id)
      return res
        .status(400)
        .json({ status: false, error: "lecture_id is required" });

    const now = now_ts ? new Date(now_ts) : new Date();

    // check lecture & teacher assignment
    const lec = await query(
      `SELECT l.*, la.role
         FROM dbo.lectures l
         LEFT JOIN dbo.lecture_assignments la ON la.lecture_id = l.id AND la.user_id = @p1
        WHERE l.id = @p0`,
      [lecture_id, req.user.id]
    );
    if (!lec.recordset.length)
      return res
        .status(404)
        .json({ status: false, error: "Lecture not found" });

    const L = lec.recordset[0];
    if (L.role !== "teacher" && req.user.role !== "admin") {
      return res.status(403).json({
        status: false,
        error: "Only assigned teacher/admin can start",
      });
    }

    if (
      modulation_string &&
      L.modulation_string &&
      modulation_string !== L.modulation_string
    ) {
      return res
        .status(400)
        .json({ status: false, error: "Modulation mismatch" });
    }

    // upsert today's session
    const planned_date = now.toISOString().slice(0, 10);
    const upsert = `
      MERGE dbo.lecture_sessions AS t
      USING (
        SELECT l.id AS lecture_id, @p1 AS planned_date, l.start_time, l.end_time
        FROM dbo.lectures l WHERE l.id = @p0
      ) AS s
      ON (t.lecture_id = s.lecture_id AND t.planned_date = s.planned_date)
      WHEN MATCHED THEN
        UPDATE SET status = 'started', started_at = SYSUTCDATETIME(), started_by = @p2
      WHEN NOT MATCHED THEN
        INSERT (lecture_id, planned_date, planned_start_time, planned_end_time, status, started_at, started_by)
        VALUES (s.lecture_id, s.planned_date, s.start_time, s.end_time, 'started', SYSUTCDATETIME(), @p2)
      OUTPUT INSERTED.id;
    `;
    const r = await query(upsert, [lecture_id, planned_date, req.user.id]);
    const session_id = r.recordset[0].id;

    // notify assigned students (and teachers if you want)
    const io = req.app.get("io");
    io.to(`lec:${lecture_id}:students`).emit("lecture_started", {
      lecture_id,
      session_id,
      at: new Date().toISOString(),
    });
    io.to(`lec:${lecture_id}:teachers`).emit("lecture_started", {
      lecture_id,
      session_id,
      at: new Date().toISOString(),
    });

    return res.json({
      status: true,
      lecture_id,
      session_id,
      message: "Lecture started",
    });
  } catch (e) {
    console.error("start lecture error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to start lecture" });
  }
});

/**
 * POST /lecture-sessions/end
 * Body: { lecture_id }
 */
router.post("/end", auth, async (req, res) => {
  try {
    const { lecture_id, now_ts } = req.body;
    if (!lecture_id)
      return res
        .status(400)
        .json({ status: false, error: "lecture_id is required" });

    const now = now_ts ? new Date(now_ts) : new Date();
    const isoNow = now.toISOString();

    // First try by date (so tests with back-dates work)
    let sql = `
      UPDATE dbo.lecture_sessions
         SET status='ended', ended_at=@p1
       WHERE lecture_id=@p0
         AND planned_date = CAST(@p1 AS DATE)
         AND status='started';
      SELECT @@ROWCOUNT AS affected;
    `;
    let r = await query(sql, [lecture_id, isoNow]);

    // Fallback: end latest started session
    if (!r.recordset[0].affected) {
      sql = `
        ;WITH s AS (
          SELECT TOP 1 *
          FROM dbo.lecture_sessions
          WHERE lecture_id=@p0 AND status='started'
          ORDER BY planned_date DESC, ISNULL(started_at,'0001-01-01') DESC, id DESC
        )
        UPDATE s SET status='ended', ended_at=@p1;
        SELECT @@ROWCOUNT AS affected;
      `;
      r = await query(sql, [lecture_id, isoNow]);
    }

    if (!r.recordset[0].affected)
      return res
        .status(400)
        .json({ status: false, error: "No started session to end" });

    const io = req.app.get("io");
    const payload = { lecture_id, at: isoNow };
    io.to(`lec:${lecture_id}:students`).emit("lecture_ended", payload);
    io.to(`lec:${lecture_id}:teachers`).emit("lecture_ended", payload);

    return res.json({ status: true, lecture_id, message: "Lecture ended" });
  } catch (e) {
    console.error("end lecture error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to end lecture" });
  }
});

module.exports = router;
