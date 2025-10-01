// utils/paging.js
function parsePaging(q) {
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || "20", 10))); // cap at 100
  const search = (q.search || "").trim();
  return { page, limit, search };
}

module.exports = { parsePaging };
