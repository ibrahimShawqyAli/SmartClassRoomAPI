const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const { parsePaging } = require("../utils/paging");

// admin gate
function requireAdmin(req, res, next) {
  if ((req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

/**
 * POST /dashboard/sections
 * Body: { name, level_id }
 *  - level_id is REQUIRED because the DB column is NOT NULL.
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const { name, level_id } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ status: false, error: "name is required" });
    }
    if (!level_id) {
      return res
        .status(400)
        .json({ status: false, error: "level_id is required" });
    }

    const r = await query(
      `
      INSERT INTO dbo.sections (name, level_id)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1)
      `,
      [name.trim(), level_id]
    );

    return res.json({
      status: true,
      id: r.recordset[0].id,
      message: "Section created",
    });
  } catch (err) {
    // FK violation (bad level_id)
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid level_id (FK violation)" });
    }
    // Unique constraint (if you have one, e.g., unique name per level)
    if (err.number === 2627 || err.number === 2601) {
      return res
        .status(409)
        .json({ status: false, error: "Section already exists" });
    }
    console.error("Create section error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/sections
 * Query: ?page=1&limit=20&search=Sec
 * If you don't have dbo.levels, remove the JOIN + level fields.
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  try {
    const { page, limit, search } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const filters = [];
    const params = [];

    if (search) {
      filters.push("s.name LIKE @p0");
      params.push(`%${search}%`);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    // total
    const cnt = await query(
      `SELECT COUNT(*) AS total FROM dbo.sections s ${where}`,
      params
    );
    const total = cnt.recordset[0].total;

    // page
    const data = await query(
      `
      SELECT
        s.id,
        s.name,
        s.level_id,
        l.name AS level_name
      FROM dbo.sections s
      LEFT JOIN dbo.levels l ON l.id = s.level_id
      ${where}
      ORDER BY s.name ASC, s.id ASC
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
      `,
      [...params, offset, limit]
    );

    return res.json({
      status: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: data.recordset,
    });
  } catch (err) {
    console.error("List sections error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/sections/:id
 */
router.get("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `
      SELECT s.id, s.name, s.level_id, l.name AS level_name
      FROM dbo.sections s
      LEFT JOIN dbo.levels l ON l.id = s.level_id
      WHERE s.id=@p0
      `,
      [req.params.id]
    );
    if (!r.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "Section not found" });
    }
    return res.json({ status: true, section: r.recordset[0] });
  } catch (err) {
    console.error("Get section error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * PATCH /dashboard/sections/:id
 * Body: { name?, level_id? }
 */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { name, level_id } = req.body || {};
    if (
      (name === undefined || !String(name).trim()) &&
      level_id === undefined
    ) {
      return res.status(400).json({
        status: false,
        error: "Nothing to update (name and/or level_id required)",
      });
    }

    const r = await query(
      `
      UPDATE dbo.sections
         SET name = COALESCE(@p1, name),
             level_id = COALESCE(@p2, level_id)
       WHERE id = @p0;
      SELECT @@ROWCOUNT AS affected;
      `,
      [req.params.id, name ? name.trim() : null, level_id ?? null]
    );

    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "Section not found" });
    }

    return res.json({ status: true, message: "Section updated" });
  } catch (err) {
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid level_id (FK violation)" });
    }
    if (err.number === 2627 || err.number === 2601) {
      return res
        .status(409)
        .json({ status: false, error: "Section already exists" });
    }
    console.error("Update section error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * DELETE /dashboard/sections/:id
 * Hard delete — blocked if referenced by offerings.
 */
router.delete("/:id", auth, requireAdmin, async (req, res) => {
  try {
    // Is it referenced?
    const ref = await query(
      `SELECT TOP 1 1 AS used
         FROM dbo.course_offerings
        WHERE section_id=@p0`,
      [req.params.id]
    );
    if (ref.recordset.length) {
      return res.status(409).json({
        status: false,
        error:
          "Section is in use by offerings. Reassign or delete those offerings first.",
      });
    }

    const r = await query(
      `DELETE FROM dbo.sections WHERE id=@p0;
       SELECT @@ROWCOUNT AS affected;`,
      [req.params.id]
    );
    if (!r.recordset[0].affected) {
      return res
        .status(404)
        .json({ status: false, error: "Section not found" });
    }

    return res.json({ status: true, message: "Section deleted" });
  } catch (err) {
    if (err.number === 547) {
      return res.status(409).json({
        status: false,
        error: "Section is referenced elsewhere and cannot be deleted.",
      });
    }
    console.error("Delete section error:", err);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
