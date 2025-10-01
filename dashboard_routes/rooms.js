// dashboard_routes/rooms.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const requireAdmin = require("../helpers/requireAdmin");

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

/** READ (add auth here too) */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const r = await query(`
      SELECT r.id, r.name, r.building_id, r.modulation_string, b.name AS building_name
      FROM dbo.rooms r
      JOIN dbo.buildings b ON b.id = r.building_id
      ORDER BY b.name, r.name
    `);
    res.json({ status: true, count: r.recordset.length, data: r.recordset });
  } catch (err) {
    console.error("List rooms error:", err);
    res.status(500).json({ status: false, error: "Failed to fetch rooms" });
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
