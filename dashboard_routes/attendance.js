// routes/attendanceReport.js
const express = require("express");
const router = express.Router();
const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

// Admin gate
function requireAdmin(req, res, next) {
  const role = (req.user?.role || req.auth?.role || "").toLowerCase();
  if (role !== "admin") {
    return res.status(403).json({ status: false, error: "Admin only" });
  }
  next();
}

// Paging helper
function parsePaging(q) {
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(1000, Math.max(1, parseInt(q.limit || "100", 10)));
  return { page, limit };
}

/**
 * Excel helper with optional title row.
 * - columns: array of { header, key, width }
 * - rows: array of plain objects from recordset
 * - title: string shown above the header (merged across all columns)
 */
async function sendExcel(res, filename, columns, rows, title = null) {
  const Excel = require("exceljs");
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet("Attendance");

  // set columns (this creates header row)
  ws.columns = columns;

  // Insert a title row above header if provided
  if (title) {
    ws.spliceRows(1, 0, [title]);
    ws.mergeCells(1, 1, 1, columns.length);
    const cell = ws.getCell(1, 1);
    cell.font = { bold: true, size: 14 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    // spacer row after title
    ws.spliceRows(2, 0, []);
  }

  // Add data rows
  rows.forEach((r) => ws.addRow(r));

  // Optional: Autofilter on header row (accounts for title + spacer)
  const headerRowIndex = title ? 3 : 1;
  ws.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: columns.length },
  };

  // Optional: nice column widths fallback
  ws.columns.forEach((c) => {
    if (!c.width)
      c.width = Math.min(Math.max((c.header || "").length + 5, 12), 40);
  });

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_") + ".xlsx";
  res.attachment(safe);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  await wb.xlsx.write(res);
  res.end();
}

// ---------- Small helpers to fetch names for titles ----------
async function getCourseNameByOffering(offeringId) {
  const sql = `
    SELECT TOP 1 c.name AS course_name
    FROM dbo.course_offerings o
    JOIN dbo.courses c ON c.id = o.course_id
    WHERE o.id = @p0
  `;
  const r = await query(sql, [offeringId]);
  return r.recordset[0]?.course_name || `Offering ${offeringId}`;
}

async function getCourseNameByCourseId(courseId) {
  const sql = `SELECT TOP 1 name AS course_name FROM dbo.courses WHERE id = @p0`;
  const r = await query(sql, [courseId]);
  return r.recordset[0]?.course_name || `Course ${courseId}`;
}

async function getUserName(userId) {
  const sql = `SELECT TOP 1 name FROM dbo.users WHERE id = @p0`;
  const r = await query(sql, [userId]);
  return r.recordset[0]?.name || `User ${userId}`;
}

/**
 * GET /dashboard/attendance/course/:id
 * Query:
 *   by=offering|course   (default: offering)
 *   date_from=YYYY-MM-DD
 *   date_to=YYYY-MM-DD
 *   role=student|teacher|assistant
 *   page=1&limit=100  (ignored if download=1)
 *   download=1        (Excel)
 *
 * NOTE:
 * - If by=offering (default), :id is course_offerings.id
 * - If by=course, :id is courses.id (we include JOIN to filter by course_id)
 */
router.get("/course/:id", auth, requireAdmin, async (req, res) => {
  try {
    const rawId = Number(req.params.id);
    const by = String(req.query.by || "offering").toLowerCase(); // offering | course
    const { date_from, date_to, role } = req.query;
    const download = String(req.query.download || "") === "1";

    // dynamic WHERE and JOINs depending on "by"
    const where = [];
    const joins = [
      "JOIN dbo.course_sessions s ON s.id = ar.session_id",
      "JOIN dbo.users u          ON u.id = ar.user_id",
    ];
    const params = [];

    if (by === "course") {
      // Filter by courses.id
      joins.push("JOIN dbo.course_offerings o ON o.id = s.offering_id");
      joins.push("JOIN dbo.courses c ON c.id = o.course_id");
      where.push(`c.id = @p${params.length}`);
      params.push(rawId);
    } else {
      // Default: filter by offering_id
      where.push(`s.offering_id = @p${params.length}`);
      params.push(rawId);
    }

    if (date_from) {
      where.push(`CAST(s.planned_start_utc AS DATE) >= @p${params.length}`);
      params.push(date_from);
    }
    if (date_to) {
      where.push(`CAST(s.planned_start_utc AS DATE) <= @p${params.length}`);
      params.push(date_to);
    }
    if (role) {
      where.push(`u.role = @p${params.length}`);
      params.push(String(role));
    }

    const baseSelect = `
      SELECT
        ar.id                       AS attendance_id,
        ar.user_id,
        u.name,
        u.email,
        u.role,
        s.id                        AS session_id,
        s.status                    AS session_status,
        s.planned_start_utc,
        s.planned_end_utc,
        ar.check_in_at,
        ar.check_out_at,
        ar.status                   AS attendance_status
      FROM dbo.attendance_records ar
      ${joins.join("\n")}
      WHERE ${where.join(" AND ")}
    `;

    if (download) {
      const data = await query(
        `${baseSelect}
         ORDER BY s.planned_start_utc, u.name, u.id`,
        params
      );

      // Build title using proper resolver depending on "by"
      let courseName;
      if (by === "course") {
        courseName = await getCourseNameByCourseId(rawId);
      } else {
        courseName = await getCourseNameByOffering(rawId);
      }
      const title = `Attendance Report for Course ${courseName}`;

      // IMPORTANT: Excel columns (remove planned start/end per request)
      return sendExcel(
        res,
        by === "course"
          ? `attendance_course_${rawId}`
          : `attendance_offering_${rawId}`,
        [
          { header: "User ID", key: "user_id", width: 10 },
          { header: "Name", key: "name", width: 25 },
          { header: "Email", key: "email", width: 28 },
          { header: "Role", key: "role", width: 12 },
          { header: "Session ID", key: "session_id", width: 12 },
          { header: "Session Status", key: "session_status", width: 14 },
          // Removed planned_start_utc and planned_end_utc from Excel
          { header: "Check-in (UTC)", key: "check_in_at", width: 22 },
          { header: "Check-out (UTC)", key: "check_out_at", width: 22 },
          { header: "Attendance Status", key: "attendance_status", width: 16 },
        ],
        data.recordset,
        title
      );
    }

    // paged JSON
    const { page, limit } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.attendance_records ar
      ${joins.join("\n")}
      WHERE ${where.join(" AND ")}
    `;
    const total = (await query(countSql, params)).recordset[0]?.total || 0;

    const pageSql = `
      ${baseSelect}
      ORDER BY s.planned_start_utc, u.name, u.id
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const pageData = await query(pageSql, [...params, offset, limit]);

    return res.json({
      status: true,
      by,
      id: rawId,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: pageData.recordset,
    });
  } catch (e) {
    console.error("attendance by course/offering error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

/**
 * GET /dashboard/attendance/user/:id
 * Query:
 *   offering_id? (optional)
 *   date_from / date_to
 *   page / limit (ignored if download=1)
 *   download=1  (Excel)
 */
router.get("/user/:id", auth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const offeringId = req.query.offering_id
      ? Number(req.query.offering_id)
      : null;
    const { date_from, date_to } = req.query;
    const download = String(req.query.download || "") === "1";

    const where = ["ar.user_id = @p0"];
    const params = [userId];

    if (offeringId) {
      where.push(`s.offering_id = @p${params.length}`);
      params.push(offeringId);
    }
    if (date_from) {
      where.push(`CAST(s.planned_start_utc AS DATE) >= @p${params.length}`);
      params.push(date_from);
    }
    if (date_to) {
      where.push(`CAST(s.planned_start_utc AS DATE) <= @p${params.length}`);
      params.push(date_to);
    }

    const baseSelect = `
      SELECT
        s.offering_id,
        c.name                    AS course_name,
        ar.session_id,
        s.status                  AS session_status,
        s.planned_start_utc,
        s.planned_end_utc,
        ar.check_in_at,
        ar.check_out_at,
        ar.status                 AS attendance_status
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions  s ON s.id = ar.session_id
      JOIN dbo.course_offerings o ON o.id = s.offering_id
      JOIN dbo.courses         c ON c.id = o.course_id
      WHERE ${where.join(" AND ")}
    `;

    if (download) {
      const data = await query(
        `${baseSelect}
         ORDER BY c.name, s.planned_start_utc, ar.session_id`,
        params
      );

      const userName = await getUserName(userId);
      const title = `Attendance Report for ${userName}`;

      // Excel without planned_start_utc / planned_end_utc
      return sendExcel(
        res,
        `attendance_user_${userId}`,
        [
          { header: "Course", key: "course_name", width: 28 },
          { header: "Offering ID", key: "offering_id", width: 12 },
          { header: "Session ID", key: "session_id", width: 12 },
          { header: "Session Status", key: "session_status", width: 14 },
          // Removed planned_* columns per request
          { header: "Check-in (UTC)", key: "check_in_at", width: 22 },
          { header: "Check-out (UTC)", key: "check_out_at", width: 22 },
          { header: "Attendance Status", key: "attendance_status", width: 16 },
        ],
        data.recordset,
        title
      );
    }

    const { page, limit } = parsePaging(req.query);
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM dbo.attendance_records ar
      JOIN dbo.course_sessions  s ON s.id = ar.session_id
      JOIN dbo.course_offerings o ON o.id = s.offering_id
      JOIN dbo.courses         c ON c.id = o.course_id
      WHERE ${where.join(" AND ")}
    `;
    const total = (await query(countSql, params)).recordset[0]?.total || 0;

    const pageSql = `
      ${baseSelect}
      ORDER BY c.name, s.planned_start_utc, ar.session_id
      OFFSET @p${params.length} ROWS
      FETCH NEXT @p${params.length + 1} ROWS ONLY;
    `;
    const pageData = await query(pageSql, [...params, offset, limit]);

    return res.json({
      status: true,
      user_id: userId,
      offering_id: offeringId || null,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      data: pageData.recordset,
    });
  } catch (e) {
    console.error("attendance by user error:", e);
    return res.status(500).json({ status: false, error: "Server error" });
  }
});

module.exports = router;
