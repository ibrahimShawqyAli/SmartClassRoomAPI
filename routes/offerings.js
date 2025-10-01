// routes/offerings.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");

/**
 * POST /offerings
 * Body: {
 *   course_id,
 *   term_id,
 *   room_id,
 *   day_of_week,
 *   start_time,          // "HH:mm" or "HH:mm:ss"
 *   duration_minutes,    // 1..600
 *   created_by
 * }
 */
router.post("/", async (req, res) => {
  try {
    const {
      course_id,
      term_id,
      room_id,
      day_of_week,
      start_time,
      duration_minutes,
      created_by,
    } = req.body;

    if (
      !course_id ||
      !term_id ||
      !room_id ||
      day_of_week === undefined ||
      !start_time ||
      !duration_minutes ||
      !created_by
    ) {
      return res
        .status(400)
        .json({ status: false, error: "Missing required fields" });
    }

    const dow = Number(day_of_week);
    const dur = Number(duration_minutes);
    if (Number.isNaN(dow) || dow < 0 || dow > 6) {
      return res
        .status(400)
        .json({ status: false, error: "day_of_week must be 0..6" });
    }
    if (Number.isNaN(dur) || dur <= 0 || dur > 600) {
      return res
        .status(400)
        .json({ status: false, error: "duration_minutes must be 1..600" });
    }

    const timeStr = /^\d{2}:\d{2}$/.test(start_time)
      ? `${start_time}:00`
      : start_time;

    // conflict check against course_sessions
    const conflictSql = `
      DECLARE @newStart TIME = @p3;
      DECLARE @newEnd   TIME = DATEADD(MINUTE, @p4, @newStart);

      IF EXISTS (
        SELECT 1
        FROM dbo.course_sessions WITH (UPDLOCK, HOLDLOCK)
        WHERE room_id = @p2
          AND day_of_week = @p1
          AND start_time < @newEnd
          AND end_time   > @newStart
      )
      BEGIN
        SELECT CAST(1 AS BIT) AS conflict;
      END
      ELSE
      BEGIN
        -- insert offering
        DECLARE @offeringId INT;
        INSERT INTO dbo.course_offerings (course_id, term_id, primary_room_id, created_by)
        VALUES (@p0, @p5, @p2, @p6);
        SET @offeringId = SCOPE_IDENTITY();

        -- insert first session
        INSERT INTO dbo.course_sessions (offering_id, day_of_week, start_time, end_time, duration_minutes, room_id, planned_start_utc, planned_end_utc)
        OUTPUT INSERTED.offering_id AS offering_id, INSERTED.id AS session_id
        VALUES (
          @offeringId,
          @p1,
          @p3,
          @newEnd,
          @p4,
          @p2,
          SYSUTCDATETIME(), -- simplified: adjust if you want exact planned dates
          DATEADD(MINUTE, @p4, SYSUTCDATETIME())
        );
      END
    `;

    const r = await query(conflictSql, [
      course_id, // @p0
      dow, // @p1
      room_id, // @p2
      timeStr, // @p3
      dur, // @p4
      term_id, // @p5
      created_by, // @p6
    ]);

    if (r.recordset.length && r.recordset[0].conflict) {
      return res.status(400).json({
        status: false,
        error:
          "Conflict: another session exists at this room and time interval",
      });
    }

    return res.json({
      status: true,
      offering_id: r.recordset[0].offering_id,
      session_id: r.recordset[0].session_id,
      message: "Offering + first session created successfully",
    });
  } catch (err) {
    console.error("Add offering error:", err);
    if (err.number === 2601 || err.number === 2627) {
      return res
        .status(400)
        .json({ status: false, error: "Unique constraint violation" });
    }
    return res
      .status(500)
      .json({ status: false, error: "Failed to create offering" });
  }
});

/**
 * GET /offerings
 * Returns all offerings with their course name and sessions
 */
router.get("/", async (req, res) => {
  try {
    const sql = `
      SELECT
        o.id             AS offering_id,
        c.name           AS course_name,
        t.name           AS term_name,
        r.name           AS room_name,
        s.id             AS session_id,
        s.day_of_week,
        CONVERT(VARCHAR(8), s.start_time, 108) AS start_time,
        CONVERT(VARCHAR(8), s.end_time, 108)   AS end_time,
        s.duration_minutes,
        s.status
      FROM dbo.course_offerings o
      JOIN dbo.courses c ON c.id = o.course_id
      JOIN dbo.terms t   ON t.id = o.term_id
      LEFT JOIN dbo.rooms r ON r.id = o.primary_room_id
      LEFT JOIN dbo.course_sessions s ON s.offering_id = o.id
      ORDER BY c.name, s.day_of_week, s.start_time;
    `;
    const r = await query(sql);
    return res.json({
      status: true,
      count: r.recordset.length,
      data: r.recordset,
    });
  } catch (err) {
    console.error("List offerings error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch offerings" });
  }
});

module.exports = router;
