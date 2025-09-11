// routes/face.js  (CommonJS)
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const mime = require("mime-types");
const axios = require("axios");
const FormData = require("form-data");
const http = require("http");
const { query } = require("../DB/dbConnection"); // CJS import

const router = express.Router();

/* ---------- Config ---------- */
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "faces");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const fr = axios.create({
  baseURL: process.env.FR_BASE_URL || "http://127.0.0.1:5000",
  timeout: 15000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
});

/* ---------- Helpers ---------- */
function bufferFromBase64(dataUriOrRaw) {
  const commaIdx = dataUriOrRaw.indexOf(",");
  const base64 =
    commaIdx >= 0 ? dataUriOrRaw.slice(commaIdx + 1) : dataUriOrRaw;
  return Buffer.from(base64, "base64");
}

function pickIncomingImage(req) {
  const f = req.file;
  const b64 = req.body.image_base64;
  if (f)
    return {
      buffer: f.buffer,
      mimeType: f.mimetype || "application/octet-stream",
      originalName: f.originalname || "upload.jpg",
    };
  if (b64)
    return {
      buffer: bufferFromBase64(b64),
      mimeType: "image/jpeg",
      originalName: "upload.jpg",
    };
  return null;
}

/* =========================================================
   API A: Add/replace user's reference photo
   POST /fr/photo
   Body:
     - user_id: number (required)
     - EITHER multipart file field name "file" OR JSON `image_base64`
   ========================================================= */
router.post("/photo", upload.single("file"), async (req, res) => {
  try {
    const user_id = Number(req.body.user_id);
    if (!user_id) {
      return res
        .status(400)
        .json({ status: false, error: "user_id is required" });
    }

    const img = pickIncomingImage(req);
    if (!img) {
      return res.status(400).json({
        status: false,
        error: "No image provided. Send multipart 'file' or 'image_base64'.",
      });
    }

    // find existing photo (so we can delete old file)
    const existing = await query(
      "SELECT file_path FROM dbo.user_photos WHERE user_id=@p0",
      [user_id]
    );
    const oldPath = existing.recordset[0]?.file_path;

    // new file name
    const ext = mime.extension(img.mimeType) || "jpg";
    const safeRand = crypto.randomBytes(8).toString("hex");
    const filename = `${user_id}_${Date.now()}_${safeRand}.${ext}`;
    const absPath = path.join(UPLOAD_DIR, filename);
    const relPath = path.join("uploads", "faces", filename).replace(/\\/g, "/");

    fs.writeFileSync(absPath, img.buffer);

    // upsert DB
    const sql = `
      MERGE dbo.user_photos AS t
      USING (SELECT @p0 AS user_id, @p1 AS file_path) AS s
      ON (t.user_id = s.user_id)
      WHEN MATCHED THEN UPDATE SET file_path = s.file_path, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (user_id, file_path) VALUES (s.user_id, s.file_path)
      OUTPUT INSERTED.user_id, INSERTED.file_path;
    `;
    await query(sql, [user_id, relPath]);

    // delete old file
    if (oldPath) {
      const oldAbs = path.join(process.cwd(), oldPath);
      if (fs.existsSync(oldAbs)) {
        try {
          fs.unlinkSync(oldAbs);
        } catch {}
      }
    }

    return res.json({
      status: true,
      user_id,
      photo_url: `/${relPath}`,
    });
  } catch (e) {
    console.error("FR /photo error:", e);
    return res
      .status(500)
      .json({ status: false, error: "Failed to save photo" });
  }
});

/* =========================================================
   API B: Verify a probe image against user's stored reference
   POST /fr/verify-user
   Body:
     - user_id: number (required)
     - EITHER multipart file field "file" OR `image_base64`
   Calls Python /verify with (file1=stored, file2=probe)
   ========================================================= */
router.post("/verify-user", upload.single("file"), async (req, res) => {
  try {
    const user_id = Number(req.body.user_id);
    if (!user_id) {
      return res
        .status(400)
        .json({ status: false, error: "user_id is required" });
    }

    const probe = pickIncomingImage(req);
    if (!probe) {
      return res.status(400).json({
        status: false,
        error: "No image provided. Send multipart 'file' or 'image_base64'.",
      });
    }

    // find stored reference
    const existing = await query(
      "SELECT file_path FROM dbo.user_photos WHERE user_id=@p0",
      [user_id]
    );
    if (!existing.recordset.length) {
      return res
        .status(404)
        .json({ status: false, error: "No reference photo for this user" });
    }
    const refRel = existing.recordset[0].file_path;
    const refAbs = path.join(process.cwd(), refRel);
    if (!fs.existsSync(refAbs)) {
      return res
        .status(410)
        .json({ status: false, error: "Reference photo missing on server" });
    }

    // build multipart to Python
    const form = new FormData();
    form.append("file1", fs.createReadStream(refAbs), {
      filename: path.basename(refAbs),
      contentType: mime.lookup(refAbs) || "image/jpeg",
    });
    form.append("file2", probe.buffer, {
      filename: "probe.jpg",
      contentType: probe.mimeType,
    });

    const py = await fr.post("/verify", form, { headers: form.getHeaders() });
    const data = py.data;

    return res.json({
      status: true,
      user_id,
      match: Boolean(data.match),
      score: data.score,
      raw: data,
    });
  } catch (e) {
    console.error("FR /verify-user error:", e?.response?.data || e.message);
    return res
      .status(502)
      .json({ status: false, error: e?.response?.data || e.message });
  }
});

module.exports = router;
