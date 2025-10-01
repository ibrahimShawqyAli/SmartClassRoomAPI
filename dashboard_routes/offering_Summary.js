// dashboard_routes/offerings.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");
const requireAdmin = require("../helpers/requireAdmin");
const { parsePaging } = require("../utils/paging");

/**
 * GET /dashboard/offerings/summary
 * Query:
 *   ?page=1&limit=20
 *   &search=prog          // optional, matches course name
 *   &term_id=3            // optional, filter by academic term
 *
 * Response:
 * {
 *   status: true,
 *   page, limit, total, pages,
 *   data: [
 *     { offering_id, course_name, teachers_count, students_count }
 *   ]
 * }
 */
router.get("/summary", auth, requireAdmin, async (req, res) => {
  try {
    const { page, limit, search } = parsePaging(req.query);
    const termId = req.query.term_id ? Number(req.query.term_id) : null;

    // Build WHERE + params for filtering
    const whereParts = [];
    const params = [];

    if (search) {
      whereParts.push(`c.name LIKE @p${params.length}`);
      params.push(`%${search}%`);
    }
    if (termId) {
      whereParts.push(`o.term_id = @p${params.length}`);
      params.push(termId);
    }

    const whereClause = whereParts.length
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    // 1) Total count for pagination (distinct offerings with filters)
    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.course_offerings o
      JOIN dbo.courses c ON c.id = o.course_id
      ${whereClause};
    `;
    const countRes = await query(countSql, params);
    const total = countRes.recordset[0]?.total || 0;

    if (total === 0) {
      return res.json({
        status: true,
        page,
        limit,
        total: 0,
        pages: 0,
        data: [],
      });
    }

    // 2) Page of data with aggregates (teachers/students per offering)
    const offset = (page - 1) * limit;
    const dataSql = `
      WITH base AS (
        SELECT
          o.id AS offering_id,
          c.name AS course_name
        FROM dbo.course_offerings o
        JOIN dbo.courses c ON c.id = o.course_id
        ${whereClause}
      )
      SELECT
        b.offering_id,
        b.course_name,
        ISNULL(SUM(CASE WHEN oa.role = 'teacher' THEN 1 ELSE 0 END), 0) AS teachers_count,
        ISNULL(SUM(CASE WHEN oa.role = 'student' THEN 1 ELSE 0 END), 0) AS students_count
      FROM base b
      LEFT JOIN dbo.offering_assignments oa
        ON oa.offering_id = b.offering_id
      GROUP BY b.offering_id, b.course_name
      ORDER BY b.course_name ASC, b.offering_id ASC
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
  } catch (e) {
    console.error("offerings summary error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
