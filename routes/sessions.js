// routes/sessions.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/**
 * POST /lecture-sessions/start
 * Body: { offering_id, modulation_string?, now_ts? }
 */
router.post("/start", auth, async (req, res) => {
  try {
    const { offering_id, modulation_string, now_ts } = req.body || {};
    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id is required" });
    }

    const user = req.user || req.auth || {};
    console.log("[SESSIONS/START] body:", req.body);
    console.log("[SESSIONS/START] user:", user);

    // 1) Load offering + primary room modulation + teacher flag (new + legacy)
    const offerSql = `
      SELECT 
        o.id,
        o.day_of_week,
        o.start_time,
        o.end_time,
        o.primary_room_id,
        r.modulation_string AS room_mod,
        CASE WHEN EXISTS (
          SELECT 1 FROM dbo.course_assignments ca
          WHERE ca.offering_id=@p0 AND ca.user_id=@p1 AND LOWER(ca.role)='teacher'
        ) OR EXISTS (
          SELECT 1 FROM dbo.offering_assignments oa
          WHERE oa.offering_id=@p0 AND oa.user_id=@p1 AND LOWER(oa.role)='teacher'
        ) THEN 1 ELSE 0 END AS is_teacher
      FROM dbo.course_offerings o
      LEFT JOIN dbo.rooms r ON r.id = o.primary_room_id
      WHERE o.id=@p0;
    `;
    const offerRes = await query(offerSql, [offering_id, user.id]);
    if (!offerRes.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Offering not found" });
    }
    const O = offerRes.recordset[0];

    // 2) Authorization: assigned teacher or admin
    const isAdmin = String(user.role || "").toLowerCase() === "admin";
    const isTeacher = !!O.is_teacher;
    if (!isAdmin && !isTeacher) {
      return res.status(403).json({
        status: false,
        error: "Only assigned teacher/admin can start",
      });
    }

    // 3) Modulation check (only enforced if room has modulation)
    const roomMod = (O.room_mod || "").trim();
    const providedMod = (modulation_string || "").trim();
    if (!isAdmin && roomMod) {
      if (!providedMod || providedMod !== roomMod) {
        return res.status(400).json({
          status: false,
          error: "Modulation required and must match room",
        });
      }
    }

    // 4) Upsert/Start today's session
    const now = now_ts ? new Date(now_ts) : new Date();
    const isoNow = now.toISOString();

    // NOTE: Some SQL Servers have triggers on dbo.course_sessions.
    // We must OUTPUT INTO a table variable, then SELECT from it.
    const upsert = `
      DECLARE @started TABLE (id INT);

      MERGE dbo.course_sessions AS t
      USING (
        SELECT 
          @p0 AS offering_id,
          @p1 AS planned_start_utc,
          DATEADD(MINUTE, 30, @p1) AS planned_end_utc
      ) AS s
      ON (t.offering_id = s.offering_id
          AND CAST(t.planned_start_utc AS DATE) = CAST(s.planned_start_utc AS DATE))
      WHEN MATCHED THEN
        UPDATE SET 
          status      = 'started',
          started_at  = SYSUTCDATETIME(),
          started_by  = @p2
          -- If you have these columns in course_sessions, uncomment to persist:
          -- , provided_modulation       = @p3
          -- , room_modulation_at_start  = @p4
      WHEN NOT MATCHED THEN
        INSERT (offering_id, planned_start_utc, planned_end_utc, status, started_at, started_by
                -- , provided_modulation, room_modulation_at_start
               )
        VALUES (s.offering_id, s.planned_start_utc, s.planned_end_utc, 'started', SYSUTCDATETIME(), @p2
                -- , @p3, @p4
               )
      OUTPUT INSERTED.id INTO @started(id);

      SELECT cs.id,
             cs.offering_id,
             cs.planned_start_utc,
             cs.planned_end_utc,
             cs.started_at,
             cs.ended_at,
             cs.status
      FROM dbo.course_sessions cs
      WHERE cs.id = (SELECT TOP 1 id FROM @started);
    `;
    const ins = await query(upsert, [
      offering_id, // @p0
      isoNow, // @p1
      user.id, // @p2
      providedMod, // @p3 (if you enable persistence above)
      roomMod, // @p4 (if you enable persistence above)
    ]);

    const row = ins.recordset[0];
    const session_id = row.id;

    // 5) Notify sockets
    const io = req.app.get("io");
    const payload = { offering_id, session_id, at: new Date().toISOString() };
    io.to(`off:${offering_id}:students`).emit("session_started", payload);
    io.to(`off:${offering_id}:teachers`).emit("session_started", payload);

    return res.json({
      status: true,
      offering_id,
      session_id,
      message: "Session started",
      // Extra context you asked for (time + modulation):
      planned_start_utc: row.planned_start_utc,
      planned_end_utc: row.planned_end_utc,
      started_at: row.started_at,
      room_modulation: roomMod || null,
      provided_modulation: providedMod || null,
    });
  } catch (e) {
    console.error("start session error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to start session" });
  }
});

/**
 * POST /lecture-sessions/end
 * Body: { offering_id, now_ts?, modulation_string? }
 * (modulation_string is optional; if you have a column for it, you can persist similarly)
 */
router.post("/end", auth, async (req, res) => {
  try {
    const { offering_id, now_ts, modulation_string } = req.body || {};
    if (!offering_id) {
      return res
        .status(400)
        .json({ status: false, error: "offering_id is required" });
    }

    const now = now_ts ? new Date(now_ts) : new Date();
    const isoNow = now.toISOString();
    const providedMod = (modulation_string || "").trim();

    // End today's started session first
    let sql = `
      UPDATE dbo.course_sessions
         SET status='ended', ended_at=@p1
             -- If you have an "provided_modulation_on_end" column, uncomment:
             -- , provided_modulation_on_end = @p2
       WHERE offering_id=@p0
         AND CAST(planned_start_utc AS DATE) = CAST(@p1 AS DATE)
         AND status='started';
      SELECT @@ROWCOUNT AS affected;
    `;
    let r = await query(sql, [offering_id, isoNow, providedMod]);

    // Fallback: latest started session
    if (!r.recordset[0].affected) {
      sql = `
        ;WITH s AS (
          SELECT TOP 1 *
          FROM dbo.course_sessions
          WHERE offering_id=@p0 AND status='started'
          ORDER BY planned_start_utc DESC, ISNULL(started_at,'0001-01-01') DESC, id DESC
        )
        UPDATE s SET status='ended', ended_at=@p1
        -- If you have "provided_modulation_on_end" column, also set it here:
        -- , provided_modulation_on_end = @p2
        ;
        SELECT @@ROWCOUNT AS affected;
      `;
      r = await query(sql, [offering_id, isoNow, providedMod]);
    }

    if (!r.recordset[0].affected) {
      return res
        .status(400)
        .json({ status: false, error: "No started session to end" });
    }

    // Fetch the session we just ended to return times
    const getSql = `
      SELECT TOP 1
             cs.id,
             cs.offering_id,
             cs.planned_start_utc,
             cs.planned_end_utc,
             cs.started_at,
             cs.ended_at,
             cs.status
      FROM dbo.course_sessions cs
      WHERE cs.offering_id = @p0
      ORDER BY cs.planned_start_utc DESC, cs.id DESC;
    `;
    const sRow = (await query(getSql, [offering_id])).recordset[0];

    const io = req.app.get("io");
    const payload = { offering_id, at: isoNow };
    io.to(`off:${offering_id}:students`).emit("session_ended", payload);
    io.to(`off:${offering_id}:teachers`).emit("session_ended", payload);

    return res.json({
      status: true,
      offering_id,
      message: "Session ended",
      // Times + any modulation you passed now
      planned_start_utc: sRow.planned_start_utc,
      planned_end_utc: sRow.planned_end_utc,
      started_at: sRow.started_at,
      ended_at: sRow.ended_at,
      provided_modulation_on_end: providedMod || null,
    });
  } catch (e) {
    console.error("end session error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to end session" });
  }
});

module.exports = router;
