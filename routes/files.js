const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const mime = require("mime-types");

const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/* ---------- Multer (local disk) ---------- */
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || "bin";
    const safeName = (file.originalname || "file").replace(/[^\w.\-]+/g, "_");
    const rand = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${rand}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    // Example: allow common docs/images/zips
    const allowed = [
      "application/pdf",
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "image/png",
      "image/jpeg",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type"));
  },
});

/* ---------- Helpers ---------- */

// Check that user is assigned to lecture with role
async function getAssignmentRole(lectureId, userId) {
  const r = await query(
    `SELECT role FROM dbo.lecture_assignments WHERE lecture_id=@p0 AND user_id=@p1`,
    [lectureId, userId]
  );
  return r.recordset[0]?.role || null;
}

// Get a session and lecture_id by session_id
async function getSession(sessionId) {
  const r = await query(`SELECT * FROM dbo.lecture_sessions WHERE id=@p0`, [
    sessionId,
  ]);
  return r.recordset[0] || null;
}

// Ensure session belongs to lecture and is for today (optional)
function isToday(dateLike) {
  const d = new Date(dateLike);
  const today = new Date();
  const iso = (x) => x.toISOString().slice(0, 10);
  return iso(d) === iso(today);
}

/* =========================================================
   1) Teacher upload a file to a session
   POST /files/upload
   Body (multipart/form-data): { session_id, title? , file }
   Auth: teacher assigned to that lecture or admin
   ========================================================= */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    const { session_id, title } = req.body;
    if (!session_id) {
      // cleanup uploaded temp file if any
      if (req.file) fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ status: false, error: "session_id is required" });
    }
    const session = await getSession(Number(session_id));
    if (!session) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res
        .status(404)
        .json({ status: false, error: "Session not found" });
    }

    // Who owns this session?
    const lectureId = session.lecture_id;

    // Check teacher assignment
    const assignRole = await getAssignmentRole(lectureId, req.user.id);
    const isTeacher = assignRole === "teacher" || req.user.role === "admin";
    if (!isTeacher) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({
        status: false,
        error: "Only assigned teacher/admin can upload",
      });
    }

    // (optional) only allow upload for today's session
    // if (!isToday(session.planned_date)) {
    //   if (req.file) fs.unlinkSync(req.file.path);
    //   return res.status(400).json({ status: false, error: "Can only upload to today's session" });
    // }

    if (!req.file) {
      return res.status(400).json({ status: false, error: "file is required" });
    }

    const filePath = req.file.path; // server path
    const originalName = req.file.originalname;
    const finalTitle = title?.trim() || originalName;

    // Save metadata in posts
    // posts: (session_id, user_id, type='file', title, file_url)
    const ins = `
        INSERT INTO dbo.posts (session_id, user_id, [type], title, file_url, created_at)
        OUTPUT INSERTED.id
        VALUES (@p0, @p1, 'file', @p2, @p3, SYSUTCDATETIME())
      `;
    const fileUrl = `/uploads/${path.basename(filePath)}`; // stored link (relative)
    const r = await query(ins, [
      Number(session_id),
      req.user.id,
      finalTitle,
      fileUrl,
    ]);

    return res.json({
      status: true,
      post_id: r.recordset[0].id,
      session_id: Number(session_id),
      title: finalTitle,
      file_url: fileUrl,
      message: "File uploaded",
    });
  } catch (err) {
    console.error("upload error:", err);
    // try to cleanup file on error
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
    return res.status(500).json({ status: false, error: "Upload failed" });
  }
});

/* =========================================================
   2) List files for a session
   GET /files/list?session_id=123
   Auth: assigned to lecture (student/teacher/admin)
   ========================================================= */
router.get("/list", auth, async (req, res) => {
  try {
    const session_id = Number(req.query.session_id);
    if (!session_id)
      return res
        .status(400)
        .json({ status: false, error: "session_id is required" });

    const session = await getSession(session_id);
    if (!session)
      return res
        .status(404)
        .json({ status: false, error: "Session not found" });

    const lectureId = session.lecture_id;
    const assignRole = await getAssignmentRole(lectureId, req.user.id);
    if (!assignRole && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this lecture" });
    }

    const sql = `
      SELECT p.id AS post_id, p.title, p.file_url, p.created_at, u.name AS uploaded_by
      FROM dbo.posts p
      JOIN dbo.users u ON u.id = p.user_id
      WHERE p.session_id=@p0 AND p.[type]='file'
      ORDER BY p.created_at DESC
    `;
    const r = await query(sql, [session_id]);
    return res.json({
      status: true,
      count: r.recordset.length,
      files: r.recordset,
    });
  } catch (err) {
    console.error("list files error:", err);
    return res
      .status(500)
      .json({ status: false, error: "Failed to list files" });
  }
});

/* =========================================================
   3) Download a file by post_id
   GET /files/download/:postId
   Auth: assigned to lecture (student/teacher/admin)
   ========================================================= */
router.get("/download/:postId", auth, async (req, res) => {
  try {
    const postId = Number(req.query.postId);
    const sql = `
      SELECT p.*, s.lecture_id
      FROM dbo.posts p
      JOIN dbo.lecture_sessions s ON s.id = p.session_id
      WHERE p.id=@p0 AND p.[type]='file'
    `;
    const r = await query(sql, [postId]);
    if (!r.recordset.length)
      return res.status(404).json({ status: false, error: "File not found" });

    const P = r.recordset[0];

    // must be assigned
    const assignRole = await getAssignmentRole(P.lecture_id, req.user.id);
    if (!assignRole && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this lecture" });
    }

    // resolve file on disk
    if (!P.file_url || !P.file_url.startsWith("/uploads/")) {
      return res
        .status(410)
        .json({ status: false, error: "File path invalid" });
    }
    const filePath = path.join(process.cwd(), P.file_url);
    if (!fs.existsSync(filePath)) {
      return res
        .status(410)
        .json({ status: false, error: "File missing from server" });
    }

    // stream download
    res.download(filePath, P.title || path.basename(filePath));
  } catch (err) {
    console.error("download error:", err);
    return res.status(500).json({ status: false, error: "Download failed" });
  }
});

module.exports = router;
