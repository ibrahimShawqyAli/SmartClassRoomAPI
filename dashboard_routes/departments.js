// dashboard_routes/departments.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const requireAdmin = require("../helpers/requireAdmin");
/**
 * CREATE Department
 * POST /dashboard/departments
 * Body: { name, description? }
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name) {
      return res.status(400).json({ status: false, error: "name is required" });
    }

    const sql = `
      INSERT INTO dbo.departments (name, description)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1)
    `;
    const r = await query(sql, [name, description || null]);

    return res.json({
      status: true,
      id: r.recordset[0].id,
      message: "Department created successfully",
    });
  } catch (err) {
    console.error("Create department error:", err);
    if (err.number === 2627 || err.number === 2601) {
      return res
        .status(409)
        .json({ status: false, error: "Department already exists" });
    }
    return res
      .status(500)
      .json({ status: false, error: "Failed to create department" });
  }
});

/**
 * READ all Departments
 * GET /dashboard/departments
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const sql = `
      SELECT id, name, description
      FROM dbo.departments
      ORDER BY name
    `;
    const r = await query(sql);

    return res.json({
      status: true,
      count: r.recordset.length,
      data: r.recordset,
    });
  } catch (err) {
    console.error("List departments error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to fetch departments" });
  }
});

/**
 * UPDATE Department
 * PATCH /dashboard/departments/:id
 * Body: { name?, description? }
 */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body || {};
    if (!name && description === undefined) {
      return res
        .status(400)
        .json({ status: false, error: "No fields to update" });
    }

    const sql = `
      UPDATE dbo.departments
         SET name = COALESCE(@p1, name),
             description = COALESCE(@p2, description)
       WHERE id = @p0;
      SELECT @@ROWCOUNT AS affected;
    `;
    const r = await query(sql, [id, name || null, description || null]);

    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "Department not found" });
    }

    return res.json({
      status: true,
      message: "Department updated successfully",
    });
  } catch (err) {
    console.error("Update department error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to update department" });
  }
});

/**
 * DELETE Department
 * DELETE /dashboard/departments/:id
 */
router.delete("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `DELETE FROM dbo.departments WHERE id=@p0; SELECT @@ROWCOUNT AS affected;`;
    const r = await query(sql, [id]);

    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "Department not found" });
    }

    return res.json({
      status: true,
      message: "Department deleted successfully",
    });
  } catch (err) {
    console.error("Delete department error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to delete department" });
  }
});

module.exports = router;
