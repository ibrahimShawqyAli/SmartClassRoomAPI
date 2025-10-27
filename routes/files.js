// routes/files.js — final (new schema)
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
// const mime = require("mime-types"); // not used

const { query } = require("../DB/dbConnection");
const auth = require("../middleware/auth");

/* ---------- Multer (local disk) ---------- */
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = (file.originalname || "file").replace(/[^\w.\-]+/g, "_");
    const rand = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${rand}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      "application/pdf",
      "application/zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "image/png",
      "image/jpeg",
      "text/plain",
      "application/octet-stream", // Postman sometimes uses this
    ]);
    if (allowed.has(file.mimetype)) return cb(null, true);
    return cb(new Error("Unsupported file type"));
  },
});

/* ---------- Helpers (new schema) ---------- */
function getReqUser(req) {
  const src = req.auth || req.user || {};
  return { id: src.id, role: (src.role || "").toLowerCase() };
}

// course_sessions carries offering_id — we validate uploads against the offering
async function getSession(sessionId) {
  const r = await query(
    `SELECT id, offering_id, planned_start_utc, planned_end_utc
       FROM dbo.course_sessions
      WHERE id=@p0`,
    [sessionId]
  );
  return r.recordset[0] || null;
}

async function getOfferingRole(offeringId, userId) {
  const r = await query(
    `SELECT role
       FROM dbo.offering_assignments
      WHERE offering_id=@p0 AND user_id=@p1`,
    [offeringId, userId]
  );
  return r.recordset[0]?.role || null;
}

/* =========================================================
   1) Upload a file to a session (teacher/admin)
   POST /files/upload
   Body (multipart/form-data): { session_id, title?, file }
   ========================================================= */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    const { id: userId, role: userRole } = getReqUser(req);
    const { session_id, title } = req.body || {};

    if (!session_id) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      return res
        .status(400)
        .json({ status: false, error: "session_id is required" });
    }

    const session = await getSession(Number(session_id));
    if (!session) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      return res
        .status(404)
        .json({ status: false, error: "Session not found" });
    }

    // Only assigned teacher or admin can upload
    const assignRole = await getOfferingRole(session.offering_id, userId);
    const ar = (assignRole || "").toLowerCase();
    const isTeacher = ar === "teacher" || userRole === "admin";
    if (!isTeacher) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      return res
        .status(403)
        .json({
          status: false,
          error: "Only assigned teacher/admin can upload",
        });
    }

    if (!req.file) {
      // Multer rejected the file (type/size) or no file field named "file"
      return res.status(400).json({ status: false, error: "file is required" });
    }

    const fileUrl = `/uploads/${path.basename(req.file.path)}`; // relative URL
    const finalTitle = (title || req.file.originalname || "file").trim();

    const ins = `
      INSERT INTO dbo.posts (session_id, user_id, [type], title, file_url, created_at)
      OUTPUT INSERTED.id
      VALUES (@p0, @p1, 'file', @p2, @p3, SYSUTCDATETIME());
    `;
    const r = await query(ins, [
      Number(session_id),
      userId,
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
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
    return res.status(500).json({ status: false, error: "Upload failed" });
  }
});

/* =========================================================
   2) List files for a session (assigned student/teacher/admin)
   GET /files/list?session_id=123
   ========================================================= */
router.get("/list", auth, async (req, res) => {
  try {
    const { id: userId, role: userRole } = getReqUser(req);
    const session_id = Number(req.query.session_id);
    if (!session_id) {
      return res
        .status(400)
        .json({ status: false, error: "session_id is required" });
    }

    const session = await getSession(session_id);
    if (!session) {
      return res
        .status(404)
        .json({ status: false, error: "Session not found" });
    }

    const assignRole = await getOfferingRole(session.offering_id, userId);
    if (!assignRole && userRole !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this course" });
    }

    const sql = `
      SELECT p.id AS post_id, p.title, p.file_url, p.created_at, u.name AS uploaded_by
        FROM dbo.posts p
        JOIN dbo.users u ON u.id = p.user_id
       WHERE p.session_id=@p0 AND p.[type]='file'
       ORDER BY p.created_at DESC;
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
   3) Download a file by post_id (assigned student/teacher/admin)
   GET /files/download/:postId
   ========================================================= */
router.get("/download/1", auth, async (req, res) => {
  const { id: userId, role: userRole } = getReqUser(req);
  const postId = Number(req.query.postId);
    if (!postId) {
      return res
        .status(400)
        .json({ status: false, error: "postId is required" });
    }

    // Join via course_sessions to resolve offering_id
    const sql = `
      SELECT p.id, p.session_id, p.title, p.file_url, s.offering_id
        FROM dbo.posts p
        JOIN dbo.course_sessions s ON s.id = p.session_id
       WHERE p.id=@p0 AND p.[type]='file';
    `;
    const r = await query(sql, [postId]);
    if (!r.recordset.length) {
      return res.status(404).json({ status: false, error: "File not found" });
    }

    const P = r.recordset[0];
    const assignRole = await getOfferingRole(P.offering_id, userId);
    if (!assignRole && userRole !== "admin") {
      return res
        .status(403)
        .json({ status: false, error: "Not assigned to this course" });
    }

    if (!P.file_url || !P.file_url.startsWith("/uploads/")) {
      return res
        .status(410)
        .json({ status: false, error: "File path invalid" });
    }
    const filename = path.basename(P.file_url);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res
        .status(410)
        .json({ status: false, error: "File missing from server" });
    }

    return res.download(filePath, P.title || filename);
  } catch (err) {
    console.error("download error:", err);
    return res.status(500).json({ status: false, error: "Download failed" });
  }
});

/* ---------- Optional: clearer error for bad file type ---------- */
router.use((err, req, res, next) => {
  if (err && err.message === "Unsupported file type") {
    return res.status(400).json({ status: false, error: err.message });
  }
  next(err);
});

module.exports = router;
