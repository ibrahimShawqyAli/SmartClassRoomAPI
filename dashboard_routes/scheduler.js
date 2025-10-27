// dashboard_routes/scheduler.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// --- Admin guard ---
function requireAdmin(req, res, next) {
  const role = (req.user?.role || req.auth?.role || "").toLowerCase();
  if (role !== "admin")
    return res.status(403).json({ status: false, error: "Admin only" });
  next();
}

/* ---------- Time helpers ---------- */
function parseHHMM(str) {
  // returns minutes from midnight
  const m = String(str || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error("Invalid time format, expected HH:MM");
  const h = Number(m[1]),
    mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59)
    throw new Error("Invalid time range");
  return h * 60 + mm;
}
function mmToHHMM(mm) {
  const h = Math.floor(mm / 60);
  const m = mm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToSQLTime(hhmm) {
  return `${hhmm}:00`; // TIME(0) string
}

/* 
  POST /dashboard/scheduler/suggest
  Body: {
    course_ids: [int,...],           // required (5+ ok)
    day_start: 0,                    // required (0..6)
    day_end: 4,                      // required (0..6)
    work_start: "08:00",             // required
    work_end: "16:00",               // required
    slot_minutes: 90,                // optional default 90
    term_id?: int|null,
    section_id?: int|null,
    group_id?: int|null,
    room_ids?: [int,...]             // optional: restrict to these rooms
  }
  Returns suggestions only (no DB writes).
*/
router.post("/suggest", auth, requireAdmin, async (req, res) => {
  try {
    const {
      course_ids,
      day_start,
      day_end,
      work_start,
      work_end,
      slot_minutes = 90,
      term_id = null,
      section_id = null,
      group_id = null,
      room_ids = null,
    } = req.body || {};

    // Validate inputs
    if (!Array.isArray(course_ids) || course_ids.length === 0) {
      return res
        .status(400)
        .json({
          status: false,
          error: "course_ids is required and must be non-empty array",
        });
    }
    const ds = Number(day_start),
      de = Number(day_end);
    if (Number.isNaN(ds) || Number.isNaN(de) || ds < 0 || de > 6 || ds > de) {
      return res
        .status(400)
        .json({
          status: false,
          error: "Invalid day_start/day_end (0..6 and start <= end)",
        });
    }
    const ws = parseHHMM(work_start);
    const we = parseHHMM(work_end);
    if (we <= ws)
      return res
        .status(400)
        .json({ status: false, error: "work_end must be after work_start" });
    const dur = Number(slot_minutes) || 90;
    if (dur <= 0 || dur > 600)
      return res
        .status(400)
        .json({ status: false, error: "slot_minutes out of range (1..600)" });

    // Rooms set
    let rooms = [];
    if (Array.isArray(room_ids) && room_ids.length) {
      const inList = room_ids.map((_, i) => `@p${i}`).join(",");
      const rows = await query(
        `SELECT id, name FROM dbo.rooms WHERE id IN (${inList})`,
        room_ids
      );
      rooms = rows.recordset.map((r) => ({ id: r.id, name: r.name }));
    } else {
      const rows = await query(`SELECT id, name FROM dbo.rooms ORDER BY id`);
      rooms = rows.recordset.map((r) => ({ id: r.id, name: r.name }));
    }
    if (!rooms.length)
      return res
        .status(400)
        .json({ status: false, error: "No rooms found to schedule into" });

    // Fetch existing bookings for the selected rooms & days within work window
    // We load per room/day the intervals [start_time, end_time)
    const roomIds = rooms.map((r) => r.id);
    const pOff = roomIds.length;
    const p = [...roomIds, ds, de];
    const inRooms = roomIds.map((_, i) => `@p${i}`).join(",");
    const sql = `
      SELECT
        o.primary_room_id AS room_id,
        o.day_of_week     AS day_of_week,
        CONVERT(varchar(5), o.start_time, 108) AS start_hhmm,  -- HH:MM
        CONVERT(varchar(5), o.end_time,   108) AS end_hhmm
      FROM dbo.course_offerings o
      WHERE o.primary_room_id IN (${inRooms})
        AND o.day_of_week BETWEEN @p${pOff} AND @p${pOff + 1}
      ORDER BY o.primary_room_id, o.day_of_week, o.start_time;
    `;
    const booked = (await query(sql, p)).recordset || [];

    // Build availability map: room_id -> day -> sorted intervals (in minutes)
    const busy = new Map(); // room_id -> Map(day -> [{s,e}...])
    for (const r of rooms) busy.set(r.id, new Map());
    for (let d = ds; d <= de; d++) {
      for (const r of rooms) busy.get(r.id).set(d, []);
    }
    for (const row of booked) {
      const s = parseHHMM(row.start_hhmm);
      const e = parseHHMM(row.end_hhmm);
      const clampedS = Math.max(s, ws);
      const clampedE = Math.min(e, we);
      if (clampedE > clampedS) {
        busy
          .get(row.room_id)
          .get(row.day_of_week)
          .push({ s: clampedS, e: clampedE });
      }
    }
    // sort intervals per day
    for (const [roomId, dayMap] of busy.entries()) {
      for (const [d, arr] of dayMap.entries()) {
        arr.sort((a, b) => a.s - b.s);
      }
    }

    // Greedy placement: for each course, find first room/day gap that fits 'dur'
    const suggestions = [];
    const used = new Map(); // same structure as busy but includes our new tentative placements
    for (const r of rooms) {
      used.set(r.id, new Map());
      for (let d = ds; d <= de; d++) {
        used.get(r.id).set(d, [...busy.get(r.id).get(d)]); // copy
      }
    }

    function tryPlaceInRoomDay(roomId, day, duration) {
      const intervals = used.get(roomId).get(day);
      // scan gaps between [ws,we) considering existing intervals
      // start with previous endpoint = ws
      let prev = ws;
      for (const itv of intervals) {
        if (itv.s - prev >= duration) {
          // found gap [prev, itv.s)
          return { start: prev, end: prev + duration };
        }
        prev = Math.max(prev, itv.e);
      }
      // tail gap till we
      if (we - prev >= duration) return { start: prev, end: prev + duration };
      return null;
    }

    for (const course_id of course_ids) {
      let placed = null;
      let chosen = null;
      for (let d = ds; d <= de && !placed; d++) {
        for (const r of rooms) {
          const hit = tryPlaceInRoomDay(r.id, d, dur);
          if (hit) {
            // reserve it in 'used'
            used.get(r.id).get(d).push({ s: hit.start, e: hit.end });
            used
              .get(r.id)
              .get(d)
              .sort((a, b) => a.s - b.s);
            chosen = {
              room_id: r.id,
              day_of_week: d,
              start: hit.start,
              end: hit.end,
            };
            placed = true;
            break;
          }
        }
      }
      if (placed) {
        suggestions.push({
          course_id,
          term_id,
          section_id,
          group_id,
          room_id: chosen.room_id,
          day_of_week: chosen.day_of_week,
          start_time: mmToHHMM(chosen.start),
          end_time: mmToHHMM(chosen.end),
          duration_minutes: dur,
          ok: true,
        });
      } else {
        suggestions.push({
          course_id,
          term_id,
          section_id,
          group_id,
          room_id: null,
          day_of_week: null,
          start_time: null,
          end_time: null,
          duration_minutes: dur,
          ok: false,
          reason: "No free slot within working window",
        });
      }
    }

    return res.json({
      status: true,
      days: { start: ds, end: de },
      work_window: { start: work_start, end: work_end },
      slot_minutes: dur,
      rooms: rooms.map((r) => r.id),
      suggestions,
    });
  } catch (err) {
    console.error("scheduler/suggest error:", err);
    return res
      .status(500)
      .json({ status: false, error: err.message || "Server error" });
  }
});

/*
  POST /dashboard/scheduler/commit
  Body: {
    rows: [
      {
        course_id, term_id?, section_id?, group_id?,
        room_id, day_of_week, start_time("HH:MM"), end_time("HH:MM"),
        duration_minutes
      }, ...
    ]
  }
  Creates course_offerings for each OK row, returns offering_ids map.
*/
router.post("/commit", auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({
          status: false,
          error: "rows is required and must be non-empty",
        });
    }

    const results = [];
    for (const row of rows) {
      const {
        course_id,
        term_id = null,
        section_id = null,
        group_id = null,
        room_id,
        day_of_week,
        start_time,
        end_time,
        duration_minutes,
      } = row || {};

      // basic validation per row
      if (
        !course_id ||
        room_id == null ||
        day_of_week == null ||
        !start_time ||
        !end_time
      ) {
        results.push({ ok: false, reason: "Missing required fields", row });
        continue;
      }

      const dow = Number(day_of_week);
      if (Number.isNaN(dow) || dow < 0 || dow > 6) {
        results.push({ ok: false, reason: "Invalid day_of_week", row });
        continue;
      }

      const sHH = parseHHMM(start_time);
      const eHH = parseHHMM(end_time);
      if (eHH <= sHH) {
        results.push({
          ok: false,
          reason: "end_time must be after start_time",
          row,
        });
        continue;
      }

      // Insert with conflict guard
      const sql = `
        DECLARE @start TIME(0) = @p0;
        DECLARE @end   TIME(0) = @p1;

        -- room conflict (UPDLOCK/HOLDLOCK guards against race)
        IF EXISTS (
          SELECT 1
          FROM dbo.course_offerings WITH (UPDLOCK, HOLDLOCK)
          WHERE primary_room_id = @p2
            AND day_of_week     = @p3
            AND start_time < @end
            AND end_time   > @start
        )
        BEGIN
          SELECT CAST(NULL AS INT) AS id, CAST(1 AS BIT) AS conflict;
          RETURN;
        END

        INSERT INTO dbo.course_offerings
          (course_id, term_id, section_id, group_id,
           primary_room_id, day_of_week, start_time, end_time, duration_minutes, created_at)
        OUTPUT INSERTED.id
        VALUES
          (@p4, @p5, @p6, @p7,
           @p2, @p3, @start, @end, @p8, SYSUTCDATETIME());
      `;

      const params = [
        hhmmToSQLTime(row.start_time), // @p0
        hhmmToSQLTime(row.end_time), // @p1
        Number(room_id), // @p2
        dow, // @p3
        Number(course_id), // @p4
        term_id == null ? null : Number(term_id), // @p5
        section_id == null ? null : Number(section_id), // @p6
        group_id == null ? null : Number(group_id), // @p7
        Number(duration_minutes || eHH - sHH), // @p8
      ];

      const r = await query(sql, params);
      const rec = r.recordset?.[0];

      if (rec?.conflict) {
        results.push({
          ok: false,
          reason: "Room already booked at this day/time",
          row,
        });
      } else if (rec?.id) {
        results.push({ ok: true, offering_id: rec.id, row });
      } else {
        results.push({ ok: false, reason: "Insert failed", row });
      }
    }

    return res.json({
      status: true,
      results,
      created: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
    });
  } catch (err) {
    console.error("scheduler/commit error:", err);
    return res
      .status(500)
      .json({ status: false, error: err.message || "Server error" });
  }
});

module.exports = router;
