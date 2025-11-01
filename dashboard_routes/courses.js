// dashboard_routes/courses.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const requireAdmin = require("../helpers/requireAdmin");
const { parsePaging } = require("../utils/paging");
/**
 * CREATE Course
 * POST /dashboard/courses
 * Body: { name, code?, department_id?, credit_hours?, level_id? }
 */
router.post("/", auth, requireAdmin, async (req, res) => {
  try {
    const { name, code, department_id, credit_hours, level_id } =
      req.body || {};
    if (!name) {
      return res.status(400).json({ status: false, error: "name is required" });
    }

    const sql = `
      INSERT INTO dbo.courses (name, code, department_id, credit_hours, level_id)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1, @p2, @p3, @p4)
    `;
    const r = await query(sql, [
      name,
      code ?? null,
      department_id == null ? null : Number(department_id),
      credit_hours == null ? null : Number(credit_hours),
      level_id == null ? null : Number(level_id), // FK → dbo.levels(id)
    ]);

    return res.json({
      status: true,
      id: r.recordset[0].id,
      message: "Course created successfully",
    });
  } catch (err) {
    console.error("Create course error:", err);
    if (err.number === 2627 || err.number === 2601) {
      return res
        .status(409)
        .json({ status: false, error: "Course already exists" });
    }
    if (err.number === 547) {
      // FK violation
      return res
        .status(400)
        .json({ status: false, error: "Invalid department_id or level_id" });
    }
    return res
      .status(500)
      .json({ status: false, error: "Failed to create course" });
  }
});

/**
 * READ all Courses
 * GET /dashboard/courses
 */
router.get("/", auth, requireAdmin, async (req, res) => {
  const { page, limit, search } = parsePaging(req.query);

  const where = [];
  const params = [];
  if (search) {
    where.push("(c.code LIKE @p0 OR c.name LIKE @p0)");
    params.push(`%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    await query(
      `SELECT COUNT(*) AS total FROM dbo.courses c ${whereSql};`,
      params
    )
  ).recordset[0].total;

  const offset = (page - 1) * limit;
  const data = (
    await query(
      `
  SELECT
  c.id,
  c.code,
  c.name,
  c.credit_hours,
  c.level_id,
  l.name AS level_name
FROM dbo.courses c
LEFT JOIN dbo.levels l ON l.id = c.level_id
${whereSql}
ORDER BY c.code ASC, c.name ASC, c.id ASC
OFFSET @p${params.length} ROWS
FETCH NEXT @p${params.length + 1} ROWS ONLY;

    `,
      [...params, offset, limit]
    )
  ).recordset;

  res.json({
    status: true,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
    data,
  });
});

/**
 * UPDATE Course
 * PATCH /dashboard/courses/:id
 * Body: { name?, code?, department_id?, credit_hours? }
 */
/**
 * UPDATE Course
 * PATCH /dashboard/courses/:id
 * Body: { name?, code?, department_id?, credit_hours?, level_id? } // <-- level_id added
 */
router.patch("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, department_id, credit_hours, level_id } =
      req.body || {};

    if (
      name == null &&
      code == null &&
      department_id == null &&
      credit_hours == null &&
      level_id == null
    ) {
      return res
        .status(400)
        .json({ status: false, error: "No fields to update" });
    }

    const sql = `
      UPDATE dbo.courses
         SET name          = COALESCE(@p1, name),
             code          = COALESCE(@p2, code),
             department_id = COALESCE(@p3, department_id),
             credit_hours  = COALESCE(@p4, credit_hours),
             level_id      = COALESCE(@p5, level_id)
       WHERE id = @p0;
      SELECT @@ROWCOUNT AS affected;
    `;
    const r = await query(sql, [
      id,
      name ?? null,
      code ?? null,
      department_id == null ? null : Number(department_id),
      credit_hours == null ? null : Number(credit_hours),
      level_id == null ? null : Number(level_id),
    ]);

    if (!r.recordset[0].affected) {
      return res.status(404).json({ status: false, error: "Course not found" });
    }

    return res.json({ status: true, message: "Course updated successfully" });
  } catch (err) {
    console.error("Update course error:", err);
    if (err.number === 547) {
      return res
        .status(400)
        .json({ status: false, error: "Invalid department_id or level_id" });
    }
    return res
      .status(500)
      .json({ status: false, error: "Failed to update course" });
  }
});

/**
 * DELETE Course
 * DELETE /dashboard/courses/:id
 */
router.delete("/:id", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `DELETE FROM dbo.courses WHERE id=@p0; SELECT @@ROWCOUNT AS affected;`;
    const r = await query(sql, [id]);

    if (!r.recordset[0].affected) {
      return res.status(404).json({ status: false, error: "Course not found" });
    }

    return res.json({ status: true, message: "Course deleted successfully" });
  } catch (err) {
    console.error("Delete course error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to delete course" });
  }
});

module.exports = router;
