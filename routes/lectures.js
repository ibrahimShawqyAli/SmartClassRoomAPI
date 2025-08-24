const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");

router.post("/", async (req, res) => {
  try {
    const {
      name,
      place,
      day_of_week,
      start_time, // "HH:mm" or "HH:mm:ss"
      duration_minutes, // 1..600
      modulation_string,
      created_by,
      start_date, // "YYYY-MM-DD"
    } = req.body;

    // Basic validation
    if (
      !name ||
      !place ||
      day_of_week === undefined ||
      !start_time ||
      !duration_minutes ||
      !created_by ||
      !start_date
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return res
        .status(400)
        .json({ status: false, error: "start_date must be YYYY-MM-DD" });
    }
    const timeStr = /^\d{2}:\d{2}$/.test(start_time)
      ? `${start_time}:00`
      : start_time;

    // One atomic batch: check overlap -> insert if safe
    const sql = `
      DECLARE @newStart TIME = @p1;
      DECLARE @newEnd   TIME = DATEADD(MINUTE, @p2, @newStart);

      IF EXISTS (
        SELECT 1
        FROM dbo.lectures WITH (UPDLOCK, HOLDLOCK)
        WHERE place = @p3
          AND day_of_week = @p4
          AND start_time < @newEnd
          AND end_time   > @newStart
      )
      BEGIN
        SELECT CAST(1 AS BIT) AS conflict;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.lectures
          (name, place, day_of_week, start_date, start_time, duration_minutes, modulation_string, created_by)
        OUTPUT INSERTED.id
        VALUES
          (@p0,  @p3,   @p4,        @p7,        @p1,        @p2,               @p5,              @p6);
      END
    `;

    const r = await query(sql, [
      name, // @p0
      timeStr, // @p1
      dur, // @p2
      place, // @p3
      dow, // @p4
      modulation_string || null, // @p5
      created_by, // @p6
      start_date, // @p7
    ]);

    if (r.recordset.length && r.recordset[0].conflict) {
      return res.status(400).json({
        status: false,
        error:
          "Conflict: another lecture exists at this place and time interval",
      });
    }

    return res.json({
      status: true,
      lectureId: r.recordset[0].id,
      message: "Lecture created successfully",
    });
  } catch (err) {
    console.error("Add lecture error:", err);
    if (err.number === 2601 || err.number === 2627) {
      return res
        .status(400)
        .json({ status: false, error: "Unique constraint violation" });
    }
    return res
      .status(500)
      .json({ status: false, error: "Failed to create lecture" });
  }
});
router.get("/", async (req, res) => {
  try {
    const sql = `
      SELECT
        l.id,
        l.name,
        l.place,
        l.day_of_week,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,  -- "HH:mm:ss"
        l.duration_minutes,
        CONVERT(VARCHAR(8), l.end_time, 108)   AS end_time,    -- "HH:mm:ss" (computed)
        l.modulation_string,
        l.created_by,
        l.created_at,
        u.name AS created_by_name
      FROM dbo.lectures l
      JOIN dbo.users   u ON u.id = l.created_by
      ORDER BY l.day_of_week, l.start_time, l.place, l.id;
    `;
    const r = await query(sql);
    return res.json({
      status: true,
      count: r.recordset.length,
      data: r.recordset,
    });
  } catch (err) {
    console.error("List lectures error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch lectures" });
  }
});

router.get("/", async (req, res) => {
  try {
    const sql = `
      SELECT
        l.id,
        l.name,
        l.place,
        l.day_of_week,
        l.start_date,
        CONVERT(VARCHAR(8), l.start_time, 108) AS start_time,  -- "HH:mm:ss"
        l.duration_minutes,
        CONVERT(VARCHAR(8), l.end_time, 108)   AS end_time,    -- "HH:mm:ss" (computed)
        l.modulation_string,
        l.created_by,
        l.created_at,
        u.name AS created_by_name
      FROM dbo.lectures l
      JOIN dbo.users   u ON u.id = l.created_by
      ORDER BY l.day_of_week, l.start_time, l.place, l.id;
    `;
    const r = await query(sql);
    return res.json({
      status: true,
      count: r.recordset.length,
      data: r.recordset,
    });
  } catch (err) {
    console.error("List lectures error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch lectures" });
  }
});
module.exports = router;
