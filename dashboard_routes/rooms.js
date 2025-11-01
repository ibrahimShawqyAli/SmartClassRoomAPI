// dashboard_routes/rooms.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const requireAdmin = require("../helpers/requireAdmin");
const { parsePaging } = require("../utils/paging");

// POST /rooms/check
// Body:
// {
//   "room_id": 12,
//   "day_index": 2,
//   // EITHER pass a time slot id:
//   "time_slot_id": 5,
//   // OR pass times directly (HH:mm or minutes):
//   // "start_time": "10:00",     // or 600
//   // "end_time":   "11:30",     // or 690
//   // Optional when editing an existing offering so it doesn't conflict with itself:
//   // "exclude_offering_id": 123
// }
router.post("/check", auth, requireAdmin, async (req, res) => {
  try {
    const {
      room_id,
      day_index,
      time_slot_id,
      start_time,
      end_time,
      exclude_offering_id,
    } = req.body || {};

    // ---- basic validation
    if (!room_id || day_index === undefined) {
      return res.status(400).json({
        status: false,
        error: "room_id and day_index are required",
      });
    }

    // ---- helpers
    const toMinutes = (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (Number.isFinite(v)) return Number(v);
      // expect "HH:mm"
      const m = String(v).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return NaN;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      return hh * 60 + mm;
    };

    // ---- resolve start_minute/end_minute either from slot or from times
    let newStart = null;
    let newEnd = null;

    if (time_slot_id) {
      const slotRes = await query(
        `SELECT start_minute, end_minute
           FROM dbo.time_slots
          WHERE id=@p0`,
        [time_slot_id]
      );
      if (!slotRes.recordset.length)
        return res
          .status(404)
          .json({ status: false, error: "time_slot_id not found" });

      newStart = Number(slotRes.recordset[0].start_minute);
      newEnd = Number(slotRes.recordset[0].end_minute);
    } else {
      newStart = toMinutes(start_time);
      newEnd = toMinutes(end_time);
    }

    if (
      !Number.isFinite(newStart) ||
      !Number.isFinite(newEnd) ||
      newStart < 0 ||
      newEnd <= newStart
    ) {
      return res.status(400).json({
        status: false,
        error:
          "Invalid time range. Provide time_slot_id or valid start_time/end_time (HH:mm or minutes).",
      });
    }

    // ---- check that room exists (optional but nice)
    const roomRes = await query(`SELECT id, name FROM dbo.rooms WHERE id=@p0`, [
      room_id,
    ]);
    if (!roomRes.recordset.length) {
      return res.status(404).json({ status: false, error: "Room not found" });
    }

    // ---- conflict query (same overlap logic as offerings create/update)
    // Conflict if: NOT (existing_end <= newStart OR existing_start >= newEnd)
    const params = [room_id, day_index, newStart, newEnd];
    let excludeClause = "";
    if (exclude_offering_id) {
      excludeClause = ` AND o.id <> @p${params.length}`;
      params.push(exclude_offering_id);
    }

    const conflictSql = `
      SELECT TOP 1
             o.id               AS offering_id,
             o.course_id,
             o.start_minute,
             o.end_minute,
             o.day_index
        FROM dbo.offerings o
       WHERE o.room_id = @p0
         AND o.day_index = @p1
         AND NOT (o.end_minute <= @p2 OR o.start_minute >= @p3)
         ${excludeClause}
       ORDER BY o.start_minute ASC;
    `;

    const c = await query(conflictSql, params);
    const conflict = c.recordset[0];

    if (!conflict) {
      return res.json({
        status: true, // free to use (your requested semantics)
        free: true,
        message: "Room is free for the selected time.",
        normalized: { start_minute: newStart, end_minute: newEnd },
      });
    }

    // If we’re here, it’s taken:
    return res.json({
      status: false, // taken (your requested semantics)
      free: false,
      message: "Room is already booked for that time.",
      conflict: {
        offering_id: conflict.offering_id,
        day_index: conflict.day_index,
        start_minute: conflict.start_minute,
        end_minute: conflict.end_minute,
      },
      normalized: { start_minute: newStart, end_minute: newEnd },
    });
  } catch (err) {
    console.error("Room check error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/** CREATE */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const { name, building_id, modulation_string } = req.body || {};
    if (!name || !building_id) {
      return res
        .status(400)
        .json({ status: false, error: "name and building_id are required" });
    }
    const r = await query(
      `INSERT INTO dbo.rooms (name, building_id, modulation_string)
       OUTPUT INSERTED.id
       VALUES (@p0,@p1,@p2)`,
      [name, building_id, modulation_string || null]
    );
    res.json({
      status: true,
      id: r.recordset[0].id,
      message: "Room created successfully",
    });
  } catch (err) {
    console.error("Create room error:", err);
    if (err.number === 2627 || err.number === 2601)
      return res
        .status(409)
        .json({ status: false, error: "Room already exists in this building" });
    res.status(500).json({ status: false, error: "Failed to create room" });
  }
});

// GET /rooms?Page=1&limit=20&search=lab&building_id=3
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    // same helper you use for users
    const { page, limit, search } = parsePaging(req.query);

    // optional exact filter
    const buildingId =
      req.query.building_id !== undefined && req.query.building_id !== ""
        ? Number(req.query.building_id)
        : null;

    // dynamic WHERE with params (keep order stable!)
    const filters = [];
    const params = [];

    if (search) {
      // search across room name, building name, modulation string
      filters.push(
        "(r.name LIKE @p0 OR b.name LIKE @p0 OR r.modulation_string LIKE @p0)"
      );
      params.push(`%${search}%`);
    }

    if (Number.isFinite(buildingId)) {
      filters.push("r.building_id = @p" + params.length);
      params.push(buildingId);
    }

    const where = filters.length ? "WHERE " + filters.join(" AND ") : "";

    // total count
    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.rooms r
      JOIN dbo.buildings b ON b.id = r.building_id
      ${where};
    `;
    const countRes = await query(countSql, params);
    const total = countRes.recordset[0]?.total ?? 0;

    // paging
    const offset = (page - 1) * limit;

    // data page
    const dataSql = `
      SELECT
        r.id,
        r.name,
        r.building_id,
        r.modulation_string,
        b.name AS building_name
      FROM dbo.rooms r
      JOIN dbo.buildings b ON b.id = r.building_id
      ${where}
      ORDER BY b.name ASC, r.name ASC, r.id ASC
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const dataParams = [...params, offset, limit];
    const dataRes = await query(dataSql, dataParams);

    return res.json({
      status: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: dataRes.recordset,
    });
  } catch (err) {
    console.error("rooms list error Code:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/** UPDATE (add auth here too) */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, building_id, modulation_string } = req.body || {};
    if (!name && !building_id && modulation_string === undefined)
      return res
        .status(400)
        .json({ status: false, error: "No fields to update" });

    const r = await query(
      `UPDATE dbo.rooms
         SET name = COALESCE(@p1, name),
             building_id = COALESCE(@p2, building_id),
             modulation_string = COALESCE(@p3, modulation_string)
       WHERE id = @p0;
       SELECT @@ROWCOUNT AS affected;`,
      [id, name || null, building_id || null, modulation_string || null]
    );

    if (!r.recordset[0].affected)
      return res.status(404).json({ status: false, error: "Room not found" });

    res.json({ status: true, message: "Room updated successfully" });
  } catch (err) {
    console.error("Update room error:", err);
    res.status(500).json({ status: false, error: "Failed to update room" });
  }
});

/** DELETE (add auth here too) */
router.delete("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM dbo.rooms WHERE id=@p0; SELECT @@ROWCOUNT AS affected;`,
      [req.params.id]
    );
    if (!r.recordset[0].affected)
      return res.status(404).json({ status: false, error: "Room not found" });

    res.json({ status: true, message: "Room deleted successfully" });
  } catch (err) {
    console.error("Delete room error:", err);
    res.status(500).json({ status: false, error: "Failed to delete room" });
  }
});

module.exports = router;
